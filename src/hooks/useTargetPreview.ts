import { useEffect, useState } from "react";
import {
  extractArticlePreview,
  type ArticlePreview,
} from "../domain/articlePreview";
import type { Challenge } from "../domain/types";
import type { WikipediaGateway } from "../services/wikipediaGateway";

export type TargetPreviewState =
  | { status: "idle" }
  | { status: "loading"; challengeId: string }
  | { status: "unavailable"; challengeId: string }
  | {
      status: "ready";
      challengeId: string;
      canonicalTitle: string;
      attributionUrl: string;
      preview: ArticlePreview;
    };

export function useTargetPreview({
  challenge,
  enabled,
  gateway,
}: {
  challenge: Challenge | null;
  enabled: boolean;
  gateway: WikipediaGateway;
}): TargetPreviewState {
  const [state, setState] = useState<TargetPreviewState>({ status: "idle" });

  useEffect(() => () => gateway.clear(), [gateway]);

  useEffect(() => {
    if (!challenge) {
      setState({ status: "idle" });
      return;
    }
    if (!enabled) {
      setState((current) =>
        current.status === "ready" && current.challengeId === challenge.id
          ? current
          : { status: "idle" });
      return;
    }

    const controller = new AbortController();
    const challengeId = challenge.id;
    setState({ status: "loading", challengeId });
    void gateway.getArticle(challenge.target.title, {
      ruleset: challenge.ruleset,
      signal: controller.signal,
    }).then((article) => {
      if (controller.signal.aborted) return;
      if (
        challenge.target.pageId !== undefined &&
        article.pageId !== challenge.target.pageId
      ) {
        setState({ status: "unavailable", challengeId });
        return;
      }
      setState({
        status: "ready",
        challengeId,
        canonicalTitle: article.canonicalTitle,
        attributionUrl: article.attributionUrl,
        preview: extractArticlePreview(article),
      });
    }).catch(() => {
      if (!controller.signal.aborted) {
        setState({ status: "unavailable", challengeId });
      }
    });

    return () => controller.abort();
  }, [
    challenge?.id,
    challenge?.ruleset,
    challenge?.target.pageId,
    challenge?.target.title,
    enabled,
    gateway,
  ]);

  return state;
}
