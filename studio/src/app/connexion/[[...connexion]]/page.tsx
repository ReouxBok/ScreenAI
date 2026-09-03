import { SignIn, SignOutButton } from "@clerk/nextjs";
import { auth } from "@clerk/nextjs/server";
import { redirect } from "next/navigation";
import { getStaff } from "@/lib/auth";

export default async function ConnexionPage() {
  const staff = await getStaff();
  if (staff) redirect("/studio");
  const { userId } = await auth();

  return <main className="login"><section className="login-panel card">
    <span className="eyebrow">Accès interne</span>
    <h1>Studio Charly</h1>
    {userId ? <>
      <p className="login-error" role="alert">Cette adresse email n’est pas autorisée à accéder au Studio.</p>
      <SignOutButton><button className="secondary" type="button">Utiliser un autre compte</button></SignOutButton>
    </> : <>
      <p className="muted">Connectez-vous avec votre adresse email Limova et votre mot de passe personnel.</p>
      <SignIn routing="hash" withSignUp={false} forceRedirectUrl="/studio"/>
    </>}
  </section></main>;
}
