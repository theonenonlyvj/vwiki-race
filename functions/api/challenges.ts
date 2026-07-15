import { proxyCanonicalApi, type Env } from "../_shared/createTrackingContext";

export const onRequestGet: PagesFunction<Env> = (context) =>
  proxyCanonicalApi(context.request, context.env);

export const onRequestPost: PagesFunction<Env> = (context) =>
  proxyCanonicalApi(context.request, context.env);
