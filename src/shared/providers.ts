import type { ExtraProviderId } from './types';

export const EXTRA_PROVIDER_NAMES: Record<ExtraProviderId, string> = {
  codex: 'Codex',
  claude: 'Claude',
  cursor: 'Cursor',
  zai: 'Z.AI / GLM',
  zcode: 'ZCode',
};

export const EXTRA_PROVIDER_URLS: Record<ExtraProviderId, string> = {
  codex: 'https://chatgpt.com/codex/settings/usage',
  claude: 'https://claude.ai/settings/usage',
  cursor: 'https://cursor.com/dashboard',
  zai: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
  zcode: 'https://zcode.z.ai',
};
