import { createTrackingContext, type Env } from "../../_shared/createTrackingContext";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    return tracking.json(
      await tracking.handlers.startRun(
        (await tracking.readJson(context.request)) as {
          challengeId: string;
          playerId: string;
        },
      ),
    );
  } catch (caught) {
    return tracking.error(caught);
  }
};
