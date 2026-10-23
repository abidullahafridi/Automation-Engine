export const HTTP_STATUS = Object.freeze({
  ok: 200,
  noContent: 204,
  badRequest: 400,
  notFound: 404,
  internalServerError: 500
} as const);
