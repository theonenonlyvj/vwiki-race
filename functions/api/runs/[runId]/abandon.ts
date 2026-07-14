import {
  createTrackingContext,
  singleParam,
  type Env,
} from "../../../_shared/createTrackingContext";

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const tracking = createTrackingContext(context.env);
  try {
    return tracking.json(
      await tracking.handlers.abandonRun(singleParam(context.params.runId)),
    );
  } catch (caught) {
    return tracking.error(caught);
  }
};
