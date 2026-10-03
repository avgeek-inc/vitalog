export class OAuthError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: 400 | 401 | 503 = 400,
  ) {
    super(message);
  }
}
