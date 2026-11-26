import { Link } from "react-router-dom";
import { glossaryHref } from "../lib/glossary";
import { BookOpen } from "../lib/icons";
import { Button } from "./ui/button";

/** A small «Τι σημαίνει;» link to one entry of the «Λεξικό όρων», for the headline of a panel. */
export function GlossaryLink({ id, onClick }: { id: string; onClick?: () => void }) {
  return (
    <Button asChild variant="ghost" size="xs" className="text-cm-muted">
      <Link to={glossaryHref(id)} onClick={onClick} title="Άνοιγμα στο «Λεξικό όρων»">
        <BookOpen aria-hidden />Τι σημαίνει;
      </Link>
    </Button>
  );
}
