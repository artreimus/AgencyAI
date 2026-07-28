/** @jsxImportSource react */
import { useState } from "react";
import { Zap } from "lucide-react";

import { NewTaskComposer, type NewTaskComposerContext } from "./new-task-composer";

type HeroSuggestion = {
  title: string;
  description: string;
  prompt: string;
};

const DEFAULT_SUGGESTIONS: HeroSuggestion[] = [
  {
    title: "Summarize this workspace",
    description: "Review local files and surface the important points.",
    prompt: "Review the files in this workspace and give me a concise summary of the project, its current state, and the next three useful actions.",
  },
  {
    title: "Clean up a spreadsheet",
    description: "Drop in a CSV and describe the result you want.",
    prompt: "Create a sample CSV file with 20 rows of fake customer data (name, email, company, revenue). Then show me a summary of the data.",
  },
  {
    title: "Draft a document",
    description: "Reports, emails, or briefs from a few bullet points.",
    prompt: "Draft a one-page project brief. Ask me for the bullet points you need, then turn them into a clear, well-structured document.",
  },
  {
    title: "Automate a web task",
    description: "Use the built-in browser for repetitive steps.",
    prompt: "Open craigslist.org in the browser and search for couches for sale. Show me the top 5 results with prices.",
  },
];

export type SessionEmptyHeroProps = {
  providerCount: number;
  /** Disable submission while a default workspace is being prepared. */
  busy?: boolean;
  /** Called with the task prompt; the caller creates the session (and workspace if needed). */
  onRunTask: (prompt: string) => void;
  onOpenProviderAuth?: () => void;
  /** Workspace-scoped wiring for the full composer (skills, agents, models). */
  composer?: NewTaskComposerContext | null;
};

/**
 * Paper "first chat" empty state: the real session composer front and
 * center with local-first suggestion cards below.
 */
export function SessionEmptyHero(props: SessionEmptyHeroProps) {
  const [prompt, setPrompt] = useState("");

  const submit = () => {
    const trimmedPrompt = prompt.trim();
    if (!trimmedPrompt || props.busy) return;
    props.onRunTask(trimmedPrompt);
  };

  const fillPrompt = (value: string) => {
    setPrompt(value);
    window.dispatchEvent(new Event("openwork:focusPrompt"));
  };

  return (
    <div className="mx-auto w-full max-w-[640px] space-y-6 px-6">
      <div className="space-y-1.5 text-center">
        <h2 className="text-[24px] font-semibold leading-[30px] tracking-[-0.02em] text-foreground">
          What do you need done?
        </h2>
        <p className="text-[13px] text-muted-foreground">Describe it in plain language</p>
      </div>

      <NewTaskComposer
        draft={prompt}
        onDraftChange={setPrompt}
        onRunTask={submit}
        busy={props.busy ?? false}
        context={props.composer ?? null}
      />

      {props.providerCount === 0 && props.onOpenProviderAuth ? (
        <button
          type="button"
          className="flex w-full items-start gap-3 rounded-xl border border-blue-7/50 bg-blue-2/40 p-3.5 text-left transition-colors hover:bg-blue-3/50"
          onClick={props.onOpenProviderAuth}
        >
          <Zap className="mt-0.5 size-4 shrink-0 text-blue-10" />
          <div>
            <div className="text-[13px] font-medium text-foreground">Connect a model provider</div>
            <div className="mt-0.5 text-[12px] text-muted-foreground">
              Add an API key for Anthropic, OpenAI, Google, or other providers so tasks can run.
            </div>
          </div>
        </button>
      ) : null}

      <div className="grid gap-2 sm:grid-cols-2">
        {DEFAULT_SUGGESTIONS.map((suggestion) => (
          <button
            key={suggestion.title}
            type="button"
            className="rounded-xl border border-border bg-background p-3.5 text-left transition-colors hover:bg-accent"
            onClick={() => fillPrompt(suggestion.prompt)}
          >
            <div className="truncate text-[13px] font-medium text-foreground">{suggestion.title}</div>
            <div className="mt-0.5 line-clamp-2 text-[12px] leading-[17px] text-muted-foreground">
              {suggestion.description}
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
