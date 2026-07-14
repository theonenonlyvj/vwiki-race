import { createTrackingContext, type Env } from "../_shared/createTrackingContext";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    return tracking.json(await tracking.handlers.listChallenges());
  } catch (caught) {
    return tracking.error(caught);
  }
};

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    const account = await tracking.authorize(context.request);
    const input = (await tracking.readJson(context.request)) as {
      startTitle: string;
      targetTitle: string;
      creatorDisplayName: string;
    };
    return tracking.json(
      await tracking.handlers.createChallenge({
        ...input,
        creatorAccountId: account.accountId,
        creatorIdentityStatus: account.status,
      }),
    );
  } catch (caught) {
    return tracking.error(caught);
  }
};
