import { useState, useEffect } from "react";
import { ListTree, Bot, Brain, Settings, ChevronLeft } from "lucide-react";
import { TaskTree } from "./components-diy/TaskTree";
import { AgentChatPanel } from "./components-diy/AgentChatPanel";
import { LlmPage } from "./components-diy/LLmPage";
import { LogPanel } from "./components-diy/LogPanel";
import { AppInfo } from "./components-diy/AppInfo";
import { ToastContainer } from "./components-diy/ToastContainer";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTaskStore } from "./components-diy/store/taskStore";
import { useNotificationStore } from "./components-diy/store/notificationStore";
import { Badge } from "@/components/ui/badge";
import { setRendererActions, resetRendererActions } from "./components-diy/lib/renderer-actions";
import {
  SidebarProvider,
  Sidebar,
  SidebarHeader,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarInset,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";

type NavPage = "task" | "llm" | "agent" | "settings";

function App() {
  return <MainApp />;
}

function MainApp() {
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [currentPage, setCurrentPage] = useState<NavPage>("task");
  const [subPage, setSubPage] = useState("info");
  const { selectedUri, selectedTask, loadTree, selectTask } = useTaskStore();
  const addToast = useNotificationStore((s) => s.addToast);

  // RPC handler 回调注册 — CLI 通过 RPC bridge 调用 Renderer UI 操作
  useEffect(() => {
    setRendererActions({
      navigate: (page) => setCurrentPage(page as NavPage),
      focus: (uri) => selectTask(uri),
      toast: (msg, level) => addToast(level as 'info' | 'success' | 'error', msg),
    });
    return () => resetRendererActions();
  }, [selectTask, addToast]);

  useEffect(() => {
    if (selectedUri) setDetailsOpen(true);
  }, [selectedUri]);

  // 初始加载任务树
  useEffect(() => {
    loadTree();
  }, [loadTree]);

  return (
    <>
      <SidebarProvider defaultOpen={true}>
        <div className="h-screen flex bg-background text-foreground">
          <AppSidebar currentPage={currentPage} onPageChange={setCurrentPage} />

          <SidebarInset>
            {/* TitleBar */}
            <header className="h-10 flex items-center gap-2 px-3 bg-card border-b select-none shrink-0">
              <SidebarTrigger />
              <span className="text-sm font-bold">diy</span>
              <div className="ml-auto flex gap-1">
                <button
                  onClick={() => setDetailsOpen((v) => !v)}
                  className="text-xs px-2 py-1 rounded hover:bg-muted"
                >
                  🖥 详情
                </button>
              </div>
            </header>

            {/* Main content */}
            <main className="flex-1 flex overflow-hidden">
              <div className="flex-1 overflow-hidden">
                {currentPage === "task" && <TaskTree />}
                {currentPage === "llm" && <LlmPage />}
                {currentPage === "agent" && <AgentChatPanel />}
                {currentPage === "settings" && (
                  <div className="flex flex-col h-full">
                    <div className="flex items-center gap-2 px-3 py-2 border-b shrink-0">
                      <Tabs value={subPage} onValueChange={(v) => setSubPage(v as "info" | "logs")}>
                        <TabsList className="h-7">
                          <TabsTrigger value="info" className="text-xs px-2">
                            📊 状态
                          </TabsTrigger>
                          <TabsTrigger value="logs" className="text-xs px-2">
                            📋 日志
                          </TabsTrigger>
                        </TabsList>
                      </Tabs>
                    </div>
                    {subPage === "info" ? <AppInfo /> : <LogPanel />}
                  </div>
                )}
              </div>
              {detailsOpen && selectedTask && currentPage === "task" && (
                <div className="w-96 border-l overflow-hidden">
                  <DetailPanel />
                </div>
              )}
            </main>

            {/* StatusBar */}
            <footer className="h-7 flex items-center px-3 bg-card border-t text-xs text-muted-foreground shrink-0">
              <span>diy 管控台</span>
              {selectedUri && <span className="ml-2 text-muted-foreground/60">{selectedUri}</span>}
            </footer>
          </SidebarInset>
        </div>
      </SidebarProvider>
      <ToastContainer />
    </>
  );
}

// ─── Sidebar Navigation ─────────────────────────────────────────────
const navItems: Array<{
  id: NavPage;
  label: string;
  icon: React.ReactNode;
}> = [
  { id: "task", label: "任务树", icon: <ListTree size={16} /> },
  { id: "llm", label: "LLM", icon: <Brain size={16} /> },
  { id: "agent", label: "Agent", icon: <Bot size={16} /> },
  { id: "settings", label: "设置", icon: <Settings size={16} /> },
];

function AppSidebar({
  currentPage,
  onPageChange,
}: {
  currentPage: string;
  onPageChange: (page: NavPage) => void;
}) {
  const { state } = useSidebar();
  const isCollapsed = state === "collapsed";

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              isActive={false}
              tooltip="diy 管控台"
              className="font-bold h-10"
              onClick={() => {}}
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <circle cx="12" cy="12" r="10" />
                <path d="M12 2v4" />
                <path d="M12 18v4" />
                <path d="M2 12h4" />
                <path d="M18 12h4" />
              </svg>
              {!isCollapsed && <span>diy</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>导航</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.id}>
                  <SidebarMenuButton
                    isActive={currentPage === item.id}
                    tooltip={item.label}
                    onClick={() => onPageChange(item.id as NavPage)}
                  >
                    {item.icon}
                    {!isCollapsed && <span>{item.label}</span>}
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton isActive={false} tooltip={state === "expanded" ? "收起" : "展开"}>
              <ChevronLeft size={16} />
              {!isCollapsed && <span>收起</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

// ─── DetailPanel ─────────────────────────────────────────────────────
function DetailPanel() {
  const { selectedTask } = useTaskStore();
  const task = selectedTask as Record<string, unknown> | null;

  if (!task) {
    return (
      <div className="p-4 text-muted-foreground text-sm flex items-center justify-center h-full">
        选择任务查看详情
      </div>
    );
  }

  const uri = String(task["uri"] ?? "");
  const state = String(task["state"] ?? "");
  const title = String(task["title"] ?? "");
  const subject = String(task["subject"] ?? "");
  const created = String(task["created"] ?? "");
  const body = String(task["body"] ?? "");

  return (
    <div className="h-full overflow-y-auto p-3">
      <div className="flex items-center gap-2 mb-2">
        <span className="text-sm font-bold">{uri}</span>
        {state && <StateBadge state={state} />}
      </div>

      {title && <h2 className="text-lg font-bold text-foreground mb-2">{title}</h2>}

      <div className="flex gap-1.5 flex-wrap mb-3">
        {subject && (
          <span className="inline-block bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded">
            📂 {subject}
          </span>
        )}
        {created && (
          <span className="inline-block bg-muted text-muted-foreground text-xs px-2 py-0.5 rounded">
            🕐 {created.slice(0, 10)}
          </span>
        )}
      </div>

      <hr className="border-border my-2" />

      {body && (
        <div className="text-sm text-foreground/80 leading-relaxed whitespace-pre-wrap">{body}</div>
      )}
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const colorMap: Record<string, string> = {
    pending: "bg-diy-state-pending text-black",
    active: "bg-diy-state-active text-black",
    done: "bg-diy-state-done text-black",
    blocked: "bg-diy-state-blocked text-black",
    cancelled: "bg-diy-state-cancelled text-white",
  };
  return <Badge className={`${colorMap[state] ?? ""} border-0`}>{state}</Badge>;
}

export default App;
