"use client";

import Link from "next/link";
import { useState } from "react";

export function RecordActions({
  resource,
  id,
  onDelete,
}: {
  resource: string;
  id: string;
  onDelete: () => void;
}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="row">
      <Link className="linkbtn" href={`/assistant?type=${resource}&id=${id}`}>
        Edit with assistant
      </Link>
      {confirming ? (
        <>
          <button type="button" onClick={onDelete}>
            Confirm delete
          </button>
          <button type="button" className="linkbtn" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </>
      ) : (
        <button type="button" className="linkbtn" onClick={() => setConfirming(true)}>
          Delete
        </button>
      )}
    </div>
  );
}
