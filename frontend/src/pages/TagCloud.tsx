import { useNavigate } from "react-router-dom";
import { PageHeader } from "../components/ui/PageHeader";
import { TagCloudBody, useTagList } from "../components/TagCloudBody";
import { Hash } from "../lib/icons";

/** The Tag Cloud page (therapy profile). The DJ profile opens the same body in the Library «Ετικέτες» drawer. */
export default function TagCloud() {
  const navigate = useNavigate();
  const { tags, loading } = useTagList();

  return (
    <div className="flex h-full flex-col">
      <PageHeader
        icon={Hash}
        title="Tag Cloud"
        count={tags.length}
        subtitle="Κάνε κλικ σε ένα tag για να δεις τα tracks του στη βιβλιοθήκη. Τα chips έχουν ομοιόμορφο μέγεθος — το χρώμα δείχνει κατηγορία (αισθητική μόνο)."
      />
      <div className="min-h-0 flex-1 overflow-auto p-5">
        <TagCloudBody
          tags={tags}
          loading={loading}
          onPick={q => navigate(`/library?q=${encodeURIComponent(q)}`)}
        />
      </div>
    </div>
  );
}
