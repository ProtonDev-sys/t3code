import { memo } from "react";

export const ComposerGoalFollowUpBanner = memo(function ComposerGoalFollowUpBanner({
  objective,
}: {
  objective: string | null;
}) {
  return (
    <div className="px-4 py-3.5 sm:px-5 sm:py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase text-sm tracking-[0.2em]">Goal active</span>
        {objective ? (
          <span className="min-w-0 flex-1 truncate text-sm font-medium">{objective}</span>
        ) : null}
      </div>
    </div>
  );
});
