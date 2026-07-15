import { proxyCanonicalApi, type Env } from "../../../_shared/createTrackingContext";

export const onRequestGet: PagesFunction<Env> = (context) =>
  proxyCanonicalApi(context.request, context.env);
