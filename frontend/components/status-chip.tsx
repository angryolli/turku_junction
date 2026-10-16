import { memo } from "react";
import { Badge } from "@/components/ui/badge";
import type { Chip } from "@/lib/browser-api";

const styles: Record<Chip, string> = {
  normal: "bg-emerald-500/20 text-emerald-300 border-emerald-500/30",
  yellow: "bg-amber-500/20 text-amber-300 border-amber-500/30",
  red: "bg-red-500/20 text-red-300 border-red-500/30",
};

const labels: Record<Chip, string> = {
  normal: "Normal",
  yellow: "Yellow",
  red: "Red",
};

export const StatusChip = memo(function StatusChip({ status }: { status: Chip }) {
  return (
    <Badge variant="outline" className={styles[status]}>
      {labels[status]}
    </Badge>
  );
});
