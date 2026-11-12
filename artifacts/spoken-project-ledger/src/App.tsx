import { useEffect, useRef } from "react";
import {
  ClerkProvider,
  Show,
  SignIn,
  SignUp,
  useClerk,
  useUser,
} from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { zhCN } from "@clerk/localizations";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Link, Redirect, Route, Router as WouterRouter, Switch, useLocation } from "wouter";
import LedgerClient from "./app/ledger-client";
import "./app/globals.css";
import "./app/account-auth.css";

const queryClient = new QueryClient();
const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

if (!clerkPubKey) {
  throw new Error("Clerk is not configured for this app.");
}

function stripBase(path: string) {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

function CacheInvalidator() {
  const { addListener } = useClerk();
  const client = useQueryClient();
  const priorUser = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const nextUser = user?.id ?? null;
      if (priorUser.current !== undefined && priorUser.current !== nextUser) {
        client.clear();
      }
      priorUser.current = nextUser;
    });
    return unsubscribe;
  }, [addListener, client]);

  return null;
}

function PublicHome() {
  return (
    <main className="auth-home">
      <section className="auth-home-card">
        <div className="auth-brand">
          <img src={`${basePath}/logo.svg`} alt="" />
          <span>项目簿</span>
        </div>
        <p className="auth-eyebrow">个人项目与进展记录</p>
        <h1>让手头的事，都有着落。</h1>
        <p className="auth-description">
          记录项目、任务、依赖和下一步。每次更新先预览，再确认保存，并可查看操作回执。
        </p>
        <div className="auth-actions">
          <Link className="auth-primary" href="/sign-in">登录</Link>
          <Link className="auth-secondary" href="/sign-up">创建账户</Link>
        </div>
        <p className="auth-privacy">登录后，数据按你的账户单独保存。</p>
      </section>
    </main>
  );
}

function HomeRoute() {
  return (
    <>
      <Show when="signed-in"><Redirect to="/workspace" /></Show>
      <Show when="signed-out"><PublicHome /></Show>
    </>
  );
}

function WorkspaceContent() {
  const { signOut } = useClerk();
  const { user } = useUser();
  const displayName = user?.fullName || user?.primaryEmailAddress?.emailAddress || "本人";

  return (
    <div className="workspace-with-auth">
      <div className="account-auth-bar">
        <span>已登录：{displayName}</span>
        <button type="button" onClick={() => signOut({ redirectUrl: basePath || "/" })}>
          退出登录
        </button>
      </div>
      <LedgerClient />
    </div>
  );
}

function WorkspaceRoute() {
  return (
    <>
      <Show when="signed-in"><WorkspaceContent /></Show>
      <Show when="signed-out"><Redirect to="/" /></Show>
    </>
  );
}

function SignInRoute() {
  return (
    <main className="auth-page">
      <SignIn
        routing="path"
        path={`${basePath}/sign-in`}
        signUpUrl={`${basePath}/sign-up`}
        forceRedirectUrl={`${basePath}/workspace`}
      />
    </main>
  );
}

function SignUpRoute() {
  return (
    <main className="auth-page">
      <SignUp
        routing="path"
        path={`${basePath}/sign-up`}
        signInUrl={`${basePath}/sign-in`}
        forceRedirectUrl={`${basePath}/workspace`}
      />
    </main>
  );
}

function ClerkRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={{
        theme: shadcn,
        cssLayerName: "clerk",
        options: {
          logoPlacement: "inside",
          logoLinkUrl: basePath || "/",
          logoImageUrl: `${window.location.origin}${basePath}/logo.svg`,
        },
        variables: {
          colorPrimary: "#234c3e",
          colorForeground: "#29392f",
          colorMutedForeground: "#657268",
          colorDanger: "#a94b3d",
          colorBackground: "#ffffff",
          colorInput: "#ffffff",
          colorInputForeground: "#29392f",
          colorNeutral: "#29392f",
          fontFamily: '"PingFang SC", "Microsoft YaHei UI", system-ui, sans-serif',
          borderRadius: "12px",
        },
        elements: {
          rootBox: "w-full flex justify-center",
          cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden",
          card: "!shadow-none !border-0 !bg-transparent !rounded-none",
          footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
          headerTitle: "text-[#29392f] font-semibold",
          headerSubtitle: "text-[#657268]",
          socialButtonsBlockButtonText: "text-[#29392f]",
          formFieldLabel: "text-[#29392f]",
          footerActionLink: "text-[#234c3e] font-medium",
          footerActionText: "text-[#657268]",
          dividerText: "text-[#657268]",
          formFieldInput: "border-[#dfe6dc] text-[#29392f]",
          formButtonPrimary: "bg-[#234c3e] hover:bg-[#32624c] text-white",
          socialButtonsBlockButton: "border-[#dfe6dc] bg-white hover:bg-[#f4f7f0]",
          alertText: "text-[#a94b3d]",
          main: "gap-5",
        },
      }}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        ...zhCN,
        signIn: { ...zhCN.signIn, start: { ...(zhCN.signIn?.start ?? {}), title: "欢迎回来", subtitle: "登录以继续使用项目簿" } },
        signUp: { ...zhCN.signUp, start: { ...(zhCN.signUp?.start ?? {}), title: "创建账户", subtitle: "建立你的独立项目空间" } },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <CacheInvalidator />
        <Switch>
          <Route path="/sign-in/*?" component={SignInRoute} />
          <Route path="/sign-up/*?" component={SignUpRoute} />
          <Route path="/workspace" component={WorkspaceRoute} />
          <Route path="/" component={HomeRoute} />
          <Route><Redirect to="/" /></Route>
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

export default function App() {
  return (
    <WouterRouter base={basePath}>
      <ClerkRoutes />
    </WouterRouter>
  );
}
