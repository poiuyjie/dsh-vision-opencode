import assert from 'node:assert/strict';
import {
  PLUGIN_IMAGE_INPUT,
  countImages,
  countUniqueImages,
  installImageAdmissionOverride,
  isManagedMainRoute,
  replaceImagesWithText,
  sameStringArray,
  visionCacheKey,
} from '../core.js';

const config = { mainProvider: 'provider-a', mainModels: ['text-model'] };
assert.equal(isManagedMainRoute(config, 'provider-a', 'text-model'), true);
assert.equal(isManagedMainRoute(config, 'provider-b', 'text-model'), false);
assert.equal(isManagedMainRoute(config, 'provider-a', 'vision-model'), false);

const originalResolveModelInfo = async (provider, model) => ({
  provider,
  model,
  inputModalities: model === 'native-vision' ? ['text', 'image'] : ['text'],
});
const llmRuntime = { resolveModelInfo: originalResolveModelInfo };
const nativeVisionRoutes = new Set();
const restoreImageAdmission = installImageAdmissionOverride(
  llmRuntime,
  (provider) => provider === 'provider-a',
  (provider, model, info) => {
    const key = `${provider}\0${model}`;
    if (info.inputModalities?.includes('image')) nativeVisionRoutes.add(key);
    else nativeVisionRoutes.delete(key);
  },
);
assert.deepEqual((await llmRuntime.resolveModelInfo('provider-a', 'text-model')).inputModalities, ['text', 'image']);
assert.deepEqual((await llmRuntime.resolveModelInfo('provider-b', 'text-model')).inputModalities, ['text']);
assert.deepEqual((await llmRuntime.resolveModelInfo('provider-a', 'native-vision')).inputModalities, ['text', 'image']);
assert.equal(nativeVisionRoutes.has('provider-a\0text-model'), false);
assert.equal(nativeVisionRoutes.has('provider-a\0native-vision'), true);
restoreImageAdmission();
assert.equal(llmRuntime.resolveModelInfo, originalResolveModelInfo);

const nested = [
  { type: 'text', text: 'before' },
  { type: 'image', attachment: { attachmentId: 'top' } },
  {
    type: 'tool-result',
    content: [{ type: 'image', attachment: { attachmentId: 'nested' } }],
  },
];
assert.equal(countImages(nested), 2);
assert.equal(countUniqueImages(nested), 2);
const seenAttachmentIds = new Set();
assert.equal(countUniqueImages(nested, seenAttachmentIds), 2);
assert.equal(countUniqueImages([
  { type: 'image', attachment: { attachmentId: 'top' } },
  { type: 'image', attachment: {} },
  { type: 'image', attachment: {} },
], seenAttachmentIds), 2);
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

console.log('core selftest: ok');
