/**
 * Google OAuth client this copy of KaiPass signs in with. An OAuth client ID is public by design
 * (Google shows it to anyone who opens the sign-in page); it is not a secret.
 * A build can override it with the VITE_GOOGLE_CLIENT_ID environment variable.
 */
export const GOOGLE_CLIENT_ID: string =
  import.meta.env.VITE_GOOGLE_CLIENT_ID ||
  '637654536015-ffogr857quhu9jv53bumu34uo9do9gor.apps.googleusercontent.com';

/**
 * Google API key used only to read share links stored on Drive without signing in. Like the
 * client ID it is public; restrict it in Google Cloud to the Drive API and to the app's address.
 * Empty means shares are carried entirely inside the link instead.
 */
export const GOOGLE_API_KEY: string = import.meta.env.VITE_GOOGLE_API_KEY || '';

/** Public address of the web app; share links open there. */
export const SHARE_BASE_URL: string = import.meta.env.VITE_SHARE_BASE_URL || 'https://thanhkaiba.github.io/kaipass/';
