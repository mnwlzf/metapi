import { describe, expect, it } from 'vitest';
import {
  isMissingCheckinEndpointMessage,
  parseGroupMetaMap,
  parseGroupRatioMap,
  rememberCheckinFailureMessage,
} from './newApiPure.js';

describe('isMissingCheckinEndpointMessage', () => {
  it('recognizes the /checkin router 404 noise', () => {
    expect(isMissingCheckinEndpointMessage('Invalid URL (POST /api/user/checkin)')).toBe(true);
    expect(isMissingCheckinEndpointMessage('HTTP 404: {"error":{"message":"Invalid URL (POST /api/user/checkin)"}}')).toBe(true);
  });

  it('recognizes the legacy /sign_in router 404 noise too', () => {
    expect(isMissingCheckinEndpointMessage('Invalid URL (POST /api/user/sign_in)')).toBe(true);
    expect(isMissingCheckinEndpointMessage('HTTP 404: {"error":{"message":"Invalid URL (POST /api/user/sign_in)"}}')).toBe(true);
  });

  it('does not swallow real auth or business errors', () => {
    expect(isMissingCheckinEndpointMessage('HTTP 401: invalid access token')).toBe(false);
    expect(isMissingCheckinEndpointMessage('无权进行此操作，未登录且未提供 access token')).toBe(false);
    expect(isMissingCheckinEndpointMessage('今天已经签到过啦')).toBe(false);
  });
});

describe('rememberCheckinFailureMessage', () => {
  it('never lets missing-endpoint noise override a real failure message', () => {
    const auth = 'HTTP 401: invalid access token';
    const noise = 'Invalid URL (POST /api/user/sign_in)';
    expect(rememberCheckinFailureMessage(auth, noise)).toBe(auth);
  });

  it('still records noise when nothing better exists, and lets real errors replace it', () => {
    const noise = 'Invalid URL (POST /api/user/sign_in)';
    expect(rememberCheckinFailureMessage(undefined, noise)).toBe(noise);
    expect(rememberCheckinFailureMessage(noise, 'HTTP 401: invalid access token')).toBe('HTTP 401: invalid access token');
  });

  it('keeps already-checked-in messages authoritative in both directions', () => {
    const already = '今天已经签到过啦';
    expect(rememberCheckinFailureMessage(already, 'HTTP 401: invalid access token')).toBe(already);
    expect(rememberCheckinFailureMessage('HTTP 401: invalid access token', already)).toBe(already);
  });
});

describe('parseGroupRatioMap', () => {
  it('reads the group -> { ratio } shape new-api returns for user groups', () => {
    expect(parseGroupRatioMap({
      success: true,
      data: {
        default: { ratio: 1, desc: '默认分组' },
        vip: { ratio: 0.8, desc: '折扣分组' },
      },
    })).toEqual({ default: 1, vip: 0.8 });
  });

  it('reads the flat group -> ratio map shape', () => {
    expect(parseGroupRatioMap({ success: true, data: { default: 1, vip: 0.65 } }))
      .toEqual({ default: 1, vip: 0.65 });
  });

  it('reads array rows and alternative ratio field names', () => {
    expect(parseGroupRatioMap({
      data: [
        { group_name: 'default', rate_multiplier: 1 },
        { name: 'svip', group_ratio: '0.25' },
      ],
    })).toEqual({ default: 1, svip: 0.25 });
  });

  it('returns nothing when the payload carries no ratio', () => {
    expect(parseGroupRatioMap({ success: false, message: '未登录' })).toEqual({});
    expect(parseGroupRatioMap({ data: { default: { desc: '默认分组' } } })).toEqual({});
    expect(parseGroupRatioMap(null)).toEqual({});
  });

  it('reads a real new-api group listing, including surcharge ratios above 1', () => {
    // Trimmed from a live site: `ratio` is the billed multiplier and can be
    // either side of 1, and every group carries a vendor block plus schedule
    // flags that must not be mistaken for the multiplier.
    const payload = {
      data: {
        'CCMAX-可外接': {
          base_ratio: 1.2, desc: 'Claude MAX，外接渠道，自测', order: 1, ratio: 1.2,
          schedule_active: false, schedule_enabled: false,
          vendor: { id: 2, name: 'Anthropic', icon: 'Claude.Color' },
        },
        'codex-特价': {
          base_ratio: 0.12, desc: '特价分组', order: 12, ratio: 0.12,
          schedule_active: false, schedule_enabled: false,
          vendor: { id: 1, name: 'OpenAI', icon: 'OpenAI' },
        },
        'gemini-企业': {
          base_ratio: 3, desc: 'gemini-企业专线', order: 23, ratio: 3,
          schedule_active: false, schedule_enabled: false,
          vendor: { id: 3, name: 'Google', icon: 'Gemini.Color' },
        },
      },
      message: '',
      success: true,
    };

    expect(parseGroupRatioMap(payload)).toEqual({
      'CCMAX-可外接': 1.2,
      'codex-特价': 0.12,
      'gemini-企业': 3,
    });
  });
});

describe('parseGroupMetaMap', () => {
  it('keeps the schedule flags so an off-hours group can be reported as closed', () => {
    const payload = {
      success: true,
      data: {
        '夜间-限时': { ratio: 0.2, schedule_enabled: true, schedule_active: false },
        '全天-特价': { ratio: 0.5, schedule_enabled: true, schedule_active: true },
        '普通-分组': { ratio: 1, schedule_enabled: false, schedule_active: false },
      },
    };

    expect(parseGroupMetaMap(payload)).toEqual({
      '夜间-限时': { ratio: 0.2, scheduleEnabled: true, scheduleActive: false },
      '全天-特价': { ratio: 0.5, scheduleEnabled: true, scheduleActive: true },
      '普通-分组': { ratio: 1, scheduleEnabled: false, scheduleActive: false },
    });
  });

  it('reports missing fields as unknown instead of false', () => {
    expect(parseGroupMetaMap({ data: { default: { ratio: 1 } } })).toEqual({
      default: { ratio: 1, scheduleEnabled: null, scheduleActive: null },
    });
  });
});

