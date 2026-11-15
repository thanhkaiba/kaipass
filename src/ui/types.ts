import type { ItemDraft, ItemType } from '../lib/vault';

export const TYPE_LABEL: Record<ItemType, string> = {
  login: 'Đăng nhập',
  card: 'Thẻ',
  identity: 'Giấy tờ',
  note: 'Ghi chú bảo mật',
};

export const TYPES: ItemType[] = ['login', 'card', 'identity', 'note'];

const TEMPLATE: Record<ItemType, { name: string; secret: boolean }[]> = {
  login: [],
  card: [
    { name: 'Chủ thẻ', secret: false },
    { name: 'Số thẻ', secret: true },
    { name: 'Hết hạn', secret: false },
    { name: 'CVV', secret: true },
    { name: 'PIN', secret: true },
  ],
  identity: [
    { name: 'Họ tên', secret: false },
    { name: 'Số giấy tờ', secret: false },
    { name: 'Ngày sinh', secret: false },
    { name: 'Ngày cấp', secret: false },
    { name: 'Nơi cấp', secret: false },
    { name: 'Địa chỉ', secret: false },
  ],
  note: [],
};

export function blankDraft(type: ItemType, folderId: string): ItemDraft {
  return {
    type,
    title: '',
    username: '',
    password: '',
    url: '',
    notes: '',
    otp: '',
    fields: TEMPLATE[type].map((f) => ({ ...f, value: '' })),
    tags: [],
    favorite: false,
    folderId,
  };
}

/** Friendlier names for fields that other KeePass apps write. */
export function fieldLabel(name: string): string {
  const m = /^KP2A_URL(?:_(\d+))?$/.exec(name);
  return m ? `Địa chỉ web khác${m[1] ? ` ${m[1]}` : ''}` : name;
}
