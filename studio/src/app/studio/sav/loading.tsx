import { IntakeListSkeleton } from "./intake/skeletons";
// /studio/sav redirects to the intake console once the launch is recorded (the
// sidebar entry); its placeholder matches that destination, not the archive.
export default function SavLoading() { return <IntakeListSkeleton/>; }
