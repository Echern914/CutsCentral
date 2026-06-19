import { PageSkeleton } from "../_components/PageSkeleton";

export default function RequestsLoading() {
  return <PageSkeleton maxW="max-w-3xl" titleWidth="w-40" rows={4} />;
}
