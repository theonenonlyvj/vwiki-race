import { proxyCanonicalApi, type Env } from "../../_shared/createTrackingContext";

export const onRequestPost: PagesFunction<Env> = (context) =>
  proxyCanonicalApi(context.request, context.env);
