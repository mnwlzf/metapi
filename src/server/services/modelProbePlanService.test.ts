import { describe, expect, it } from 'vitest';
import { classifyProbeModel, getDefaultProbeIntervalHours } from './modelProbePlanService.js';

describe('model probe plan classification and automatic intervals', () => {
  it.each([
    ['gpt-4.1', 'text'],
    ['gpt-image-1', 'image'],
    ['text-embedding-3-small', 'embedding'],
    ['bge-reranker-v2-m3', 'rerank'],
    ['whisper-large-v3', 'audio'],
    ['veo-3.1', 'video'],
    ['__unknown__', 'other'],
  ] as const)('classifies %s as %s', (modelName, expected) => {
    expect(classifyProbeModel(modelName)).toBe(expected);
  });

  it('uses demand bands for conversational models and keeps costly media models low-frequency', () => {
    expect(getDefaultProbeIntervalHours('gpt-4.1', 0)).toBe(24);
    expect(getDefaultProbeIntervalHours('gpt-4.1', 5)).toBe(6);
    expect(getDefaultProbeIntervalHours('gpt-4.1', 50)).toBe(1);
    expect(getDefaultProbeIntervalHours('gpt-image-1', 500)).toBe(72);
    expect(getDefaultProbeIntervalHours('veo-3.1', 500)).toBe(72);
  });
});
