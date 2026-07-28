import { OpenWorkExtensionsPreview } from "./openwork-extensions-preview.js";

const LOCAL_FACTORY_MARKER = "__agencyAiLocalProduct";

function localFactoryInput(factoryInput: unknown): Record<string, unknown> {
  if (
    typeof factoryInput === "object"
    && factoryInput !== null
    && !Array.isArray(factoryInput)
  ) {
    return {
      ...(factoryInput as Record<string, unknown>),
      [LOCAL_FACTORY_MARKER]: true,
    };
  }
  return {
    [LOCAL_FACTORY_MARKER]: true,
    ...(factoryInput === undefined ? {} : { context: factoryInput }),
  };
}

/**
 * Local-only projection of the existing desktop/session extension tools.
 * The shared implementation retains local UI, session, browser, and extension
 * affordances while the marker removes every Connect lookup and instruction.
 */
export const AgencyAiLocalExtensions = async (factoryInput?: unknown) =>
  OpenWorkExtensionsPreview(localFactoryInput(factoryInput));
