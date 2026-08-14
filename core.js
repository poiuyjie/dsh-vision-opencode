export const PLUGIN_IMAGE_INPUT = Object.freeze(['text', 'image']);

export function sameStringArray(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

export function isManagedMainRoute(config, provider, model) {
  return typeof provider === 'string'
    && typeof model === 'string'
    && provider === config.mainProvider
    && config.mainModels.includes(model);
}

export const gateClaimKey = (provider, model) => `${provider}\0${model}`;

function modelOverride(root, provider, model) {
  if (root === null || typeof root !== 'object') return void 0;
  return root.providers?.[provider]?.modelOverrides?.[model];
}

function pruneEmptyOverride(root, providerName, modelId) {
  const provider = root.providers?.[providerName];
  if (provider?.modelOverrides?.[modelId] !== void 0
    && Object.keys(provider.modelOverrides[modelId]).length === 0) {
    delete provider.modelOverrides[modelId];
  }
  if (provider?.modelOverrides !== void 0 && Object.keys(provider.modelOverrides).length === 0) {
    delete provider.modelOverrides;
  }
}

/**
 * Plan ownership-safe image-gate changes without mutating the supplied settings.
 * A missing main route means "restore every old claim", not "do nothing".
 */
export function planGateOverrides(config, claims, userRoot, effectiveRoot) {
  const provider = typeof config.mainProvider === 'string' ? config.mainProvider : '';
  const configuredModels = provider.length === 0 || !Array.isArray(config.mainModels)
    ? []
    : [...new Set(config.mainModels.filter((model) => typeof model === 'string' && model.length > 0))];
  const desiredKeys = new Set(configuredModels.map((model) => gateClaimKey(provider, model)));
  const owned = new Map(claims.map((claim) => [gateClaimKey(claim.provider, claim.model), claim]));
  const nextUser = userRoot !== null && typeof userRoot === 'object'
    ? structuredClone(userRoot)
    : {};
  const nextClaims = [];
  const desiredModels = [];
  const released = [];
  let restored = 0;

  for (const claim of owned.values()) {
    const key = gateClaimKey(claim.provider, claim.model);
    if (desiredKeys.has(key)) continue;
    const override = modelOverride(nextUser, claim.provider, claim.model);
    if (sameStringArray(override?.input, PLUGIN_IMAGE_INPUT)) {
      if (claim.previousInput === null) delete override.input;
      else override.input = [...claim.previousInput];
      pruneEmptyOverride(nextUser, claim.provider, claim.model);
      restored += 1;
    }
  }

  for (const model of configuredModels) {
    const key = gateClaimKey(provider, model);
    const claim = owned.get(key);
    if (claim !== void 0) {
      const currentInput = modelOverride(nextUser, provider, model)?.input;
      const stillOwned = sameStringArray(currentInput, PLUGIN_IMAGE_INPUT);
      const pendingAtPreviousValue = claim.state === 'pending'
        && (claim.previousInput === null
          ? currentInput === void 0
          : sameStringArray(currentInput, claim.previousInput));
      if (stillOwned || pendingAtPreviousValue) {
        nextClaims.push(claim);
        desiredModels.push(model);
      } else {
        released.push({ provider, model });
      }
      continue;
    }

    const effective = modelOverride(effectiveRoot, provider, model);
    if (Array.isArray(effective?.input) && effective.input.includes('image')) continue;
    const user = modelOverride(nextUser, provider, model);
    nextClaims.push({
      provider,
      model,
      previousInput: Array.isArray(user?.input) ? [...user.input] : null,
      state: 'pending',
    });
    desiredModels.push(model);
  }

  return { claims: nextClaims, desiredModels, released, restored, user: nextUser };
}

export function activateGateClaims(claims, provider, models) {
  const keys = new Set(models.map((model) => gateClaimKey(provider, model)));
  return claims.map((claim) => keys.has(gateClaimKey(claim.provider, claim.model))
    ? { ...claim, state: 'active' }
    : claim);
}

export function visionCacheKey(route, attachment) {
  const attachmentId = attachment?.attachmentId;
  if (typeof attachmentId !== 'string' || attachmentId.length === 0) return void 0;
  return `${route.provider}\0${route.model}\0${attachmentId}`;
}

export function countImages(blocks) {
  let count = 0;
  for (const block of blocks) {
    if (block?.type === 'image') {
      count += 1;
    } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      count += countImages(block.content);
    }
  }
  return count;
}

/** Recursively replace every image, including images nested in tool results. */
export function replaceImagesWithText(blocks, replacementText) {
  const content = [];
  let replaced = 0;
  for (const block of blocks) {
    if (block?.type === 'image') {
      content.push({ type: 'text', text: replacementText });
      replaced += 1;
      continue;
    }
    if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      const nested = replaceImagesWithText(block.content, replacementText);
      content.push(nested.replaced > 0 ? { ...block, content: nested.content } : block);
      replaced += nested.replaced;
      continue;
    }
    content.push(block);
  }
  return { content, replaced };
}
