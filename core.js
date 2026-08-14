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

/**
 * Let DSH admit images only for routes that this plugin converts before the
 * provider call. Returns a cleanup function that restores the original API.
 */
export function installImageAdmissionOverride(llmRuntime, isManaged, onResolved = () => {}) {
  if (llmRuntime === null || typeof llmRuntime !== 'object'
    || typeof llmRuntime.resolveModelInfo !== 'function') return () => {};
  const original = llmRuntime.resolveModelInfo;
  const resolveModelInfo = original.bind(llmRuntime);
  const patched = async (provider, model, signal) => {
    const info = await resolveModelInfo(provider, model, signal);
    onResolved(provider, model, info);
    if (!isManaged(provider, model)
      || !Array.isArray(info?.inputModalities)
      || info.inputModalities.includes('image')) return info;
    return { ...info, inputModalities: [...info.inputModalities, 'image'] };
  };
  llmRuntime.resolveModelInfo = patched;
  return () => {
    if (llmRuntime.resolveModelInfo === patched) llmRuntime.resolveModelInfo = original;
  };
}

export const gateClaimKey = (provider, model) => `${provider}\0${model}`;

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

/** Count distinct attachments while treating images without an id as distinct. */
export function countUniqueImages(blocks, seenAttachmentIds = new Set()) {
  let count = 0;
  for (const block of blocks) {
    if (block?.type === 'image') {
      const attachmentId = block.attachment?.attachmentId;
      if (typeof attachmentId !== 'string' || attachmentId.length === 0) {
        count += 1;
      } else if (!seenAttachmentIds.has(attachmentId)) {
        seenAttachmentIds.add(attachmentId);
        count += 1;
      }
    } else if (block?.type === 'tool-result' && Array.isArray(block.content)) {
      count += countUniqueImages(block.content, seenAttachmentIds);
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
