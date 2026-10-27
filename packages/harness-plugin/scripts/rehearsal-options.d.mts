export type ModelRoute =
  | { readonly requested: false }
  | {
      readonly requested: true;
      readonly provider: string;
      readonly model: string;
      readonly apiKeyEnv: string;
      readonly baseUrl: string;
    };

export declare const parseModelRoute: (flags?: {
  provider?: string;
  model?: string;
  apiKeyEnv?: string;
  baseUrl?: string;
}) => ModelRoute;

export declare const modelRoutePatchLines: (route: ModelRoute) => string[];

export declare const harnessModelLines: (route: ModelRoute) => string[];
