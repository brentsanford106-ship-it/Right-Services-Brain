/**
 * Issuer used ONLY by the development login. Tokens from this issuer are
 * accepted solely when the API runs with APP_ENV=development|test and
 * DEV_AUTH_ENABLED=true. This is NOT production authentication.
 */
export const DEV_AUTH_ISSUER = "urn:rsb:dev-auth:insecure";
export const DEV_AUTH_AUDIENCE = "urn:rsb:api";
