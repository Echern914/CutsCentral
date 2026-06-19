import { PageSkeleton } from "../_components/PageSkeleton";

export default function LeaderboardLoading() {
  return <PageSkeleton maxW="max-w-2xl" titleWidth="w-40" rows={6} />;
}
