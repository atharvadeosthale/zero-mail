import { NuqsAdapter } from 'nuqs/adapters/react-router/v7';
import { SidebarProvider } from '@/components/ui/sidebar';
import { PostHogProvider } from '@/lib/posthog-provider';
import { LoadingProvider } from '@/components/context/loading-context';
import { useSettings } from '@/hooks/use-settings';
import { Provider as JotaiProvider } from 'jotai';
import type { PropsWithChildren } from 'react';
import Toaster from '@/components/ui/toast';
import { ThemeProvider } from 'next-themes';

export function ClientProviders({ children }: PropsWithChildren) {
  const { data } = useSettings();

  const theme = data?.settings.colorTheme || 'system';

  return (
    <NuqsAdapter>
      <JotaiProvider>
        <ThemeProvider
          attribute="class"
          enableSystem
          disableTransitionOnChange
          defaultTheme={theme}
        >
          <SidebarProvider>
            <PostHogProvider>
              <LoadingProvider>
                {children}
                <Toaster />
              </LoadingProvider>
            </PostHogProvider>
          </SidebarProvider>
        </ThemeProvider>
      </JotaiProvider>
    </NuqsAdapter>
  );
}
