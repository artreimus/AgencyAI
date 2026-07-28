/** @jsxImportSource react */
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const SUPPORT_URL = "https://github.com/artreimus/AgencyAI/issues/new";

/**
 * Small inline link rendered inside the remote-worker error card. When clicked,
 * it opens a dialog explaining the remote-worker upgrade situation and how to
 * reach support.
 */
export function OpenWorkDenHelpLink() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button
        type="button"
        className="mt-2 inline-flex items-center text-[11px] font-medium text-blue-11 underline-offset-2 hover:underline"
        onClick={() => setOpen(true)}
      >
        Using AgencyAI remote workers? Click here
      </button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>AgencyAI remote workers</DialogTitle>
            <DialogDescription>
              We recently upgraded our servers. If your remote worker was
              provisioned before that upgrade, it may no longer be compatible
              with the current AgencyAI app.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-3 text-[13px] leading-5 text-gray-11">
            <p>To get back online, you have two options:</p>
            <ul className="ml-4 list-disc space-y-2">
              <li>
                Open an{" "}
                <a
                  href={SUPPORT_URL}
                  className="font-medium text-blue-11 hover:underline"
                  target="_blank"
                  rel="noreferrer"
                >
                  AgencyAI support issue
                </a>{" "}
                and ask for help upgrading your worker.
              </li>
              <li>
                Include the AgencyAI version shown in About &amp; Licenses and
                the remote worker version, but never include access tokens.
              </li>
            </ul>
          </div>

          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>
              Close
            </DialogClose>
            <Button
              type="button"
              onClick={() => {
                window.open(SUPPORT_URL, "_blank", "noopener,noreferrer");
              }}
            >
              Open support issue
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
