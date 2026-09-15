import ReviewsBoard from "./ReviewsBoard";

// /reviews: staff page to attach each client's Google review link (the thing
// round 1 left un-settable) and see the recent queued/sent review-request
// rows. Thin server shell; all fetch/state logic lives in the client
// component, same pattern as /activity.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reviews",
  description: "Set each client's review link and see recent review requests.",
};

export default function ReviewsPage() {
  return <ReviewsBoard />;
}
