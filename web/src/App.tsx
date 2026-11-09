import { Navigate, Route, Routes } from "react-router-dom";
import { AuthProvider, useAuth } from "./lib/auth";
import Login from "./pages/Login";
import Home from "./pages/Home";
import WorkspacePage from "./pages/Workspace";
import BoardPage from "./pages/Board";
import AdminPage from "./pages/Admin";
import SharedBoard from "./pages/SharedBoard";
import MyWork from "./pages/MyWork";
import PublicForm from "./pages/PublicForm";
import AccountPage, { EnrolRequired } from "./pages/Account";

function Gate({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  if (loading) {
    return (
      <div className="flex h-full items-center justify-center text-sm opacity-60">
        Loading…
      </div>
    );
  }
  if (!user) return <Navigate to="/login" replace />;
  // instance requires 2FA: the server refuses everything else for this
  // session, so show enrolment instead of a page full of 403s
  if (user.mustEnrol2fa) return <EnrolRequired />;
  return <>{children}</>;
}

export default function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route path="/share/:token" element={<SharedBoard />} />
        <Route path="/form/:token" element={<PublicForm />} />
        <Route path="/my-work" element={<Gate><MyWork /></Gate>} />
        <Route path="/" element={<Gate><Home /></Gate>} />
        <Route path="/w/:workspaceId" element={<Gate><WorkspacePage /></Gate>} />
        <Route path="/b/:boardId" element={<Gate><BoardPage /></Gate>} />
        <Route path="/b/:boardId/c/:cardId" element={<Gate><BoardPage /></Gate>} />
        <Route path="/admin" element={<Gate><AdminPage /></Gate>} />
        <Route path="/account" element={<Gate><AccountPage /></Gate>} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </AuthProvider>
  );
}
