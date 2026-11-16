/**
 * "Paste a message, get an item": Claude reads text (or a screenshot) someone sent with account
 * details and returns them as structured fields. Only what the user pastes is sent, only when they
 * press the button, with their own API key, straight from this device to the Anthropic API.
 */
import Anthropic from '@anthropic-ai/sdk';
import { betaZodOutputFormat } from '@anthropic-ai/sdk/helpers/beta/zod';
import { z } from 'zod';
import { normalizeOtp } from './totp';
import type { ItemDraft } from './vault';

export const AI_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', note: 'Chính xác nhất (mặc định)' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5', note: 'Nhanh, rẻ hơn' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5', note: 'Rẻ nhất' },
] as const;

export const DEFAULT_MODEL = 'claude-opus-5-5';

const Extracted = z.object({
  items: z.array(
    z.object({
      type: z.enum(['login', 'card', 'identity', 'note']),
      title: z.string(),
      username: z.string(),
      password: z.string(),
      url: z.string(),
      otp: z.string(),
      notes: z.string(),
      fields: z.array(z.object({ name: z.string(), value: z.string(), secret: z.boolean() })),
    }),
  ),
});

const SYSTEM = `You turn messages that share account details into password-manager items.

The user pastes a chat message, email, note or screenshot (often Vietnamese, sometimes mixed with English) that someone sent them. Return one item per distinct account or secret found.

Rules:
- Copy usernames, passwords, keys and codes exactly, character for character. Never fix, translate, trim inner characters or guess them. If a value is cut off or unreadable, leave it empty rather than inventing it.
- type: "login" for website/app accounts, "card" for bank cards, "identity" for ID documents, "note" for anything else (recovery codes, Wi-Fi, API keys, licence keys).
- title: the service name, short (e.g. "AWS", "Gmail", "Shopee"); add the account in parentheses only when several items share a service, e.g. "AWS (read-only)".
- url: the sign-in address if given or obvious (e.g. https://signin.aws.amazon.com for AWS console logins, https://accounts.google.com for Google); otherwise empty.
- otp: an otpauth:// URI, or the base32 secret key for two-factor codes ("secret", "2FA key", "MFA", "khoá 2FA"). Not the 6-digit code itself, which expires. Empty when there is none.
- fields: everything else worth keeping, named the way the message names it (account ID, PIN, security answer, recovery codes...). secret=true for anything that grants access.
- notes: brief context from the message that is not a credential (who shared it, what it is for). Do not repeat secrets here.
- If nothing in the input is an account or secret, return an empty items list.`;

export class AiError extends Error {}

function client(apiKey: string): Anthropic {
  // The key is the user's own, stored inside their encrypted vault, and the call goes from their
  // device straight to the API, so a browser client is acceptable here.
  return new Anthropic({ apiKey, dangerouslyAllowBrowser: true, maxRetries: 1 });
}

function explain(e: unknown): never {
  if (e instanceof AiError) throw e;
  if (e instanceof Anthropic.AuthenticationError) throw new AiError('API key không đúng hoặc đã bị thu hồi');
  if (e instanceof Anthropic.PermissionDeniedError) throw new AiError('API key này không có quyền dùng mô hình đã chọn');
  if (e instanceof Anthropic.RateLimitError) throw new AiError('Đang vượt giới hạn gọi API, thử lại sau ít phút');
  if (e instanceof Anthropic.BadRequestError) throw new AiError(`Yêu cầu không hợp lệ: ${e.message}`);
  if (e instanceof Anthropic.APIConnectionError) throw new AiError('Không kết nối được tới Claude (kiểm tra mạng)');
  if (e instanceof Anthropic.APIError) throw new AiError(`Claude báo lỗi ${e.status ?? ''}: ${e.message}`);
  throw e;
}

/** Cheap check that a key works: lists models, which costs nothing. */
export async function checkKey(apiKey: string): Promise<void> {
  try {
    await client(apiKey).models.list({ limit: 1 });
  } catch (e) {
    explain(e);
  }
}

export interface PastedImage {
  mediaType: 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';
  /** base64, no data: prefix */
  data: string;
}

export async function extractItems(opts: {
  apiKey: string;
  model: string;
  text: string;
  images: PastedImage[];
}): Promise<ItemDraft[]> {
  const content: Anthropic.Beta.BetaContentBlockParam[] = [
    ...opts.images.map(
      (img): Anthropic.Beta.BetaContentBlockParam => ({
        type: 'image',
        source: { type: 'base64', media_type: img.mediaType, data: img.data },
      }),
    ),
    { type: 'text', text: opts.text.trim() || '(Chỉ có ảnh ở trên.)' },
  ];
  let response;
  try {
    response = await client(opts.apiKey).beta.messages.parse({
      model: opts.model,
      max_tokens: 16000,
      system: SYSTEM,
      messages: [{ role: 'user', content }],
      output_config: { effort: 'low', format: betaZodOutputFormat(Extracted) },
      // If the model declines (a false positive on text full of passwords is possible), the API
      // re-runs the request on a fallback model. Haiku has no server-side fallback.
      ...(opts.model === 'claude-haiku-5-5'
        ? {}
        : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }),
    });
  } catch (e) {
    explain(e);
  }
  if (response.stop_reason === 'refusal') throw new AiError('Claude từ chối xử lý nội dung này');
  if (response.stop_reason === 'max_tokens') throw new AiError('Nội dung quá dài, hãy dán từng phần');
  const parsed = response.parsed_output;
  if (!parsed) throw new AiError('Claude trả về kết quả không đọc được, thử lại');
  return parsed.items.map((it) => {
    let otp = '';
    try {
      otp = it.otp ? normalizeOtp(it.otp, it.title) : '';
    } catch {
      /* not a usable secret: keep it as a field instead of losing it */
    }
    const fields = it.fields.filter((f) => f.name.trim() && f.value);
    if (it.otp && !otp) fields.push({ name: 'OTP', value: it.otp, secret: true });
    return {
      type: it.type,
      title: it.title.trim() || 'Mục mới',
      username: it.username,
      password: it.password,
      url: it.url.trim(),
      notes: it.notes,
      otp,
      fields,
      tags: [],
      favorite: false,
      folderId: '',
    };
  });
}
