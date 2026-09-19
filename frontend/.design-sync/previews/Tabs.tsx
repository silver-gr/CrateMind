import { Tabs, TabsList, TabsTrigger, TabsContent } from 'cratemind-frontend'

export function Default() {
  return (
    <Tabs defaultValue="library" style={{ maxWidth: 400 }}>
      <TabsList>
        <TabsTrigger value="library">Library</TabsTrigger>
        <TabsTrigger value="sets">Sets</TabsTrigger>
        <TabsTrigger value="duplicates">Duplicates</TabsTrigger>
      </TabsList>
      <TabsContent value="library" style={{ padding: '12px 0', fontSize: 13 }}>
        2,847 tracks scanned
      </TabsContent>
      <TabsContent value="sets" style={{ padding: '12px 0', fontSize: 13 }}>
        12 sets built
      </TabsContent>
    </Tabs>
  )
}
