export type WebEnvironmentSource = Readonly<Record<string, string | undefined>>;

export type ValidatedWebEnvironment = Readonly<{
  NEXT_PUBLIC_API_BASE_URL: string;
}>;
