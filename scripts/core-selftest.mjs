import assert from 'node:assert/strict';
import {
  PLUGIN_IMAGE_INPUT,
  activateGateClaims,
  countImages,
  isManagedMainRoute,
  planGateOverrides,
  replaceImagesWithText,
  sameStringArray,
  visionCacheKey,
} from '../core.js';

const config = { mainProvider: 'provider-a', mainModels: ['text-model'] };
assert.equal(isManagedMainRoute(config, 'provider-a', 'text-model'), true);
assert.equal(isManagedMainRoute(config, 'provider-b', 'text-model'), false);
assert.equal(isManagedMainRoute(config, 'provider-a', 'vision-model'), false);

const nested = [
  { type: 'text', text: 'before' },
  { type: 'image', attachment: { attachmentId: 'top' } },
  {
    type: 'tool-result',
    content: [{ type: 'image', attachment: { attachmentId: 'nested' } }],
  },
];
assert.equal(countImages(nested), 2);
const replaced = replaceImagesWithText(nested, '[removed]');
assert.equal(replaced.replaced, 2);
assert.equal(countImages(replaced.content), 0);
assert.equal(replaced.content[2].content[0].text, '[removed]');

assert.notEqual(
  visionCacheKey({ provider: 'a', model: 'm' }, { attachmentId: 'same' }),
  visionCacheKey({ provider: 'b', model: 'm' }, { attachmentId: 'same' }),
);
assert.notEqual(
  visionCacheKey({ provider: 'a', model: 'm1' }, { attachmentId: 'same' }),
  visionCacheKey({ provider: 'a', model: 'm2' }, { attachmentId: 'same' }),
);
assert.equal(visionCacheKey({ provider: 'a', model: 'm' }, {}), undefined);
assert.equal(sameStringArray(PLUGIN_IMAGE_INPUT, ['text', 'image']), true);
assert.equal(sameStringArray(PLUGIN_IMAGE_INPUT, ['image', 'text']), false);

const overrideInput = (root, provider, model) =>
  root.providers?.[provider]?.modelOverrides?.[model]?.input;
const settingsWith = (input, extra = {}) => ({
  providers: {
    p: {
      modelOverrides: {
        m: { ...extra, ...(input === undefined ? {} : { input }) },
      },
    },
  },
});

// A new claim records the exact previous user-layer value before any gate write.
let plan = planGateOverrides(
  { mainProvider: 'p', mainModels: ['m', 'm'] },
  [],
  settingsWith(['text'], { temperature: 0.1 }),
  settingsWith(['text'], { temperature: 0.1 }),
);
assert.deepEqual(plan.desiredModels, ['m']);
assert.deepEqual(plan.claims, [{
  provider: 'p', model: 'm', previousInput: ['text'], state: 'pending',
}]);
assert.equal(plan.user.providers.p.modelOverrides.m.temperature, 0.1);
assert.deepEqual(activateGateClaims(plan.claims, 'p', plan.desiredModels), [{
  provider: 'p', model: 'm', previousInput: ['text'], state: 'active',
}]);

// A pending claim survives either side of the two-phase write boundary.
const pending = [{ provider: 'p', model: 'm', previousInput: ['text'], state: 'pending' }];
plan = planGateOverrides(
  { mainProvider: 'p', mainModels: ['m'] }, pending,
  settingsWith(['text']), settingsWith(['text']),
);
assert.deepEqual(plan.desiredModels, ['m']);
plan = planGateOverrides(
  { mainProvider: 'p', mainModels: ['m'] }, pending,
  settingsWith(PLUGIN_IMAGE_INPUT), settingsWith(PLUGIN_IMAGE_INPUT),
);
assert.deepEqual(plan.desiredModels, ['m']);

// An active claim is retained while untouched, but released after a user edit.
const active = [{ provider: 'p', model: 'm', previousInput: ['text'], state: 'active' }];
plan = planGateOverrides(
  { mainProvider: 'p', mainModels: ['m'] }, active,
  settingsWith(PLUGIN_IMAGE_INPUT), settingsWith(PLUGIN_IMAGE_INPUT),
);
assert.deepEqual(plan.desiredModels, ['m']);
plan = planGateOverrides(
  { mainProvider: 'p', mainModels: ['m'] }, active,
  settingsWith(['text', 'audio']), settingsWith(['text', 'audio']),
);
assert.deepEqual(plan.claims, []);
assert.deepEqual(plan.desiredModels, []);
assert.deepEqual(plan.released, [{ provider: 'p', model: 'm' }]);

// Clearing the configured route restores only plugin-owned input and preserves siblings.
plan = planGateOverrides(
  { mainProvider: '', mainModels: [] }, active,
  settingsWith(PLUGIN_IMAGE_INPUT, { temperature: 0.1 }),
  settingsWith(PLUGIN_IMAGE_INPUT, { temperature: 0.1 }),
);
assert.equal(plan.restored, 1);
assert.deepEqual(overrideInput(plan.user, 'p', 'm'), ['text']);
assert.equal(plan.user.providers.p.modelOverrides.m.temperature, 0.1);
assert.deepEqual(plan.claims, []);

// A claim with no previous user input removes only input and prunes an empty override.
plan = planGateOverrides(
  { mainProvider: '', mainModels: [] },
  [{ provider: 'p', model: 'm', previousInput: null, state: 'active' }],
  settingsWith(PLUGIN_IMAGE_INPUT), settingsWith(PLUGIN_IMAGE_INPUT),
);
assert.equal(plan.user.providers.p.modelOverrides, undefined);

// Legacy image support without a claim is respected and never claimed or removed.
plan = planGateOverrides(
  { mainProvider: 'p', mainModels: ['m'] }, [],
  {}, settingsWith(PLUGIN_IMAGE_INPUT),
);
assert.deepEqual(plan.claims, []);
assert.deepEqual(plan.desiredModels, []);

console.log('core selftest: ok');
