"use client";

import type { InstanceInfo } from "@/lib/types";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { HomeView } from "@/components/home-view";
import { NotebookEditor } from "@/components/notebook-editor";
import { AnalyticsView } from "@/components/analytics-view";

export function Dashboard({ info }: { info: InstanceInfo }) {
  return (
    <Tabs defaultValue="home" className="gap-6">
      <TabsList>
        <TabsTrigger value="home">Home</TabsTrigger>
        <TabsTrigger value="editor">Editor</TabsTrigger>
        <TabsTrigger value="analytics">Analytics</TabsTrigger>
      </TabsList>
      <TabsContent value="home">
        <HomeView />
      </TabsContent>
      <TabsContent value="editor">
        <NotebookEditor />
      </TabsContent>
      <TabsContent value="analytics">
        <AnalyticsView info={info} />
      </TabsContent>
    </Tabs>
  );
}
