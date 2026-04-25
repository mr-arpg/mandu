import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Toaster as Sonner } from "@/components/ui/sonner";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import Index from "./pages/Index.tsx";
import Demo from "./pages/Demo.tsx";
import NotFound from "./pages/NotFound.tsx";

const queryClient = new QueryClient();

/**
 * `vite build --mode github-pages` flips this on. In that build there is no
 * Express + SQLite backend reachable, so EVERY route maps to `<Demo />` (which
 * runs the real `Index` UI on top of an in-memory mock fetch). In every other
 * build/dev the routing is unchanged: `/` is the live DB-backed app and
 * `/demo` is just an extra showcase route.
 */
const IS_GITHUB_PAGES_BUILD = import.meta.env.MODE === "github-pages";

const App = () => (
  <QueryClientProvider client={queryClient}>
    <TooltipProvider>
      <Toaster />
      <Sonner />
      <BrowserRouter basename={import.meta.env.BASE_URL}>
        <Routes>
          {IS_GITHUB_PAGES_BUILD ? (
            <Route path="*" element={<Demo />} />
          ) : (
            <>
              <Route path="/" element={<Index />} />
              <Route path="/demo" element={<Demo />} />
              {/* ADD ALL CUSTOM ROUTES ABOVE THE CATCH-ALL "*" ROUTE */}
              <Route path="*" element={<NotFound />} />
            </>
          )}
        </Routes>
      </BrowserRouter>
    </TooltipProvider>
  </QueryClientProvider>
);

export default App;
