import {
  createTrackingContext,
  singleParam,
  type Env,
} from "../../../_shared/createTrackingContext";

export const onRequestGet: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    return tracking.json(
      await tracking.handlers.listLeaderboard(
        singleParam(context.params.challengeId),
      ),
    );
  } catch (caught) {
    return tracking.error(caught);
  }
};
