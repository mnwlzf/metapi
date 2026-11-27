export type ProbeModelType = 'text' | 'image' | 'embedding' | 'rerank' | 'audio' | 'video' | 'other';

export function classifyProbeModel(modelName: string): ProbeModelType {
  const name = String(modelName || '').trim();
  if (/(^|[-_/])rerank(er)?($|[-_/])/i.test(name)) return 'rerank';
  if (/(^|[-_/])embedding(s)?($|[-_/])|(^|[-_/])embed($|[-_/])|(^|[-_/])(?:bge-(?!rerank)|gte-|e5-|voyage-)/i.test(name)) return 'embedding';
  if (/(^|[-_/])image(s)?($|[-_/])|dall[-_]?e|imagen|stable[-_]?diffusion|sdxl|flux|recraft|ideogram|playground/i.test(name)) return 'image';
  if (/(^|[-_/])(?:audio|tts|speech|whisper|transcri(?:be|ption)|voice)(?=$|[-_/])/i.test(name)) return 'audio';
  if (/(^|[-_/])(?:video|veo|sora|cogvideo)(?=$|[-_/])/i.test(name)) return 'video';
  if (!name || name.startsWith('__') || /(^|[-_/])moderation($|[-_/])/i.test(name)) return 'other';
  return 'text';
}

export const FIRST_VERIFICATION_POLL_MS = 60_000;

export type FirstVerificationSettings = {
  enabled: boolean;
  batchSize: number;
  hourlyLimit: number;
  dailyCostLimitUsd: number;
  concurrency: number;
  mediaHourlyLimit: number;
  groupIntervalSeconds: number;
};

export const DEFAULT_FIRST_VERIFICATION_SETTINGS: FirstVerificationSettings = {
  enabled: true,
  batchSize: 4,
  hourlyLimit: 48,
  dailyCostLimitUsd: 1,
  concurrency: 2,
  mediaHourlyLimit: 2,
  groupIntervalSeconds: 2,
};

export function isPendingFirstVerification(input: {
  available: boolean | null;
  connectivity: boolean | null;
  hasProbe: boolean;
  disabled?: boolean;
}): boolean {
  return !input.disabled && input.available !== true
    && input.connectivity == null && !input.hasProbe;
}

export function isLowPriorityVerification(type: string): boolean {
  return type === 'image' || type === 'video';
}

export function parseFirstVerificationSettings(value: unknown): FirstVerificationSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('无效的首次验证设置');
  const input = value as Record<string, unknown>;
  const result = { ...DEFAULT_FIRST_VERIFICATION_SETTINGS };
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw new Error('自动首次验证开关必须为布尔值');
    result.enabled = input.enabled;
  }
  const limits = {
    batchSize: [1, 20], hourlyLimit: [1, 1000], dailyCostLimitUsd: [0.01, 1000],
    concurrency: [1, 4], mediaHourlyLimit: [0, 100], groupIntervalSeconds: [0, 60],
  } as const;
  for (const key of Object.keys(limits) as Array<keyof typeof limits>) {
    if (input[key] === undefined) continue;
    const number = input[key];
    const [min, max] = limits[key];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max
      || (key !== 'dailyCostLimitUsd' && !Number.isInteger(number))) {
      throw new Error(`无效的首次验证参数：${key}（${min}–${max}）`);
    }
    result[key] = number;
  }
  return result;
}
