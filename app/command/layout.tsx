import "./command.css";

export const metadata = {
  title: "Wing Command Center",
  description: "The Wing Digital team dashboard.",
  robots: { index: false, follow: false },
};

export default function CommandRoot({ children }: { children: React.ReactNode }) {
  return <div className="cc">{children}</div>;
}
