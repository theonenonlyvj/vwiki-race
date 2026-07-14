import {
  createTrackingContext,
  singleParam,
  type Env,
} from "../../../_shared/createTrackingContext";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    return tracking.json(
      await tracking.handlers.recordClick(
        singleParam(context.params.runId),
        (await tracking.readJson(context.request)) as {
          sourceTitle: string;
          clickedAnchorText: string;
          requestedTitle: string;
          destinationTitle: string;
          destinationPageId?: number;
          clientTimestampMs?: number;
        },
      ),
    );
  } catch (caught) {
    return tracking.error(caught);
  }
};
