import { useState, useEffect } from "react";
import { ListTree, Bot, Brain, Settings, ChevronLeft, ChevronRight } from "lucide-react";
import { TaskTree } from "./components-diy/TaskTree";
import { TaskDetailPanel } from "./components-diy/TaskDetailPanel";
import { AgentChatPanel } from "./components-diy/AgentChatPanel";
import { LlmPage } from "./components-diy/LLmPage";
import { LogPanel } from "./components-diy/LogPanel";
import { AppInfo } from "./components-diy/AppInfo";
import { ToastContainer } from "./components-diy/ToastContainer";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTaskStore } from "./components-diy/store/taskStore";
import { useNotificationStore } from "./components-diy/store/notificationStore";
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
  useSidebar,
} from "@/components/ui/sidebar";

type NavPage = "task" | "llm" | "agent" | "settings";

function App() {
  return <MainApp />;
}

function MainApp() {
  const [currentPage, setCurrentPage] = useState<NavPage>("task");
  const [subPage, setSubPage] = useState("info");
  const { selectedUri, loadTree, selectTask } = useTaskStore();
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

  // 初始加载任务树
  useEffect(() => {
    loadTree();
  }, [loadTree]);

  return (
    <>
      <SidebarProvider defaultOpen={true}>
        <div className="w-screen h-screen flex bg-background text-foreground">
          <AppSidebar currentPage={currentPage} onPageChange={setCurrentPage} />

          <SidebarInset>
            {/* TitleBar */}
            <header className="h-10 flex items-center gap-2 px-3 bg-card border-b select-none shrink-0">
              <span className="text-sm font-bold">diy</span>
            </header>

            {/* Main content — 列表占满，浮动面板叠加 */}
            <main className="flex-1 relative overflow-hidden">
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

              {/* 浮动详情面板 — 仅在 task 页且选中任务时显示 */}
              {currentPage === "task" && <TaskDetailPanel />}
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
  const { state, toggleSidebar } = useSidebar();
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
            <SidebarMenuButton
              isActive={false}
              tooltip={isCollapsed ? "展开" : "收起"}
              onClick={toggleSidebar}
            >
              {isCollapsed ? <ChevronRight size={16} /> : <ChevronLeft size={16} />}
              {!isCollapsed && <span>收起</span>}
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export default App;
