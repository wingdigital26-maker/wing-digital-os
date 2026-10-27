import LoginForm from "./LoginForm";

export const dynamic = "force-dynamic";

export default function CommandLogin() {
  return (
    <div className="cc-login">
      <h1 className="cc-h1">Wing Command Center</h1>
      <p className="cc-lede">Tap your name and type your code.</p>
      <LoginForm />
    </div>
  );
}
