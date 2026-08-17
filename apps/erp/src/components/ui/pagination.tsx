import { Button } from "@/components/ui/button";

export function Pagination({
  page,
  pageSize,
  total,
  onPageChange,
  pageSizeOptions,
  onPageSizeChange,
}: {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  pageSizeOptions?: readonly number[];
  onPageSizeChange?: (pageSize: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 px-4 py-2 text-xs text-slate-500">
      <div className="flex items-center gap-3">
        <span>
          Halaman {page + 1} dari {pageCount} · {total} total
        </span>
        {pageSizeOptions && onPageSizeChange && (
          <label className="flex items-center gap-1.5">
            <span>Per halaman</span>
            <select
              value={pageSize}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
              className="rounded border border-slate-200 bg-white px-1.5 py-0.5 text-xs text-slate-700 focus:border-blue-600 focus:outline-none"
            >
              {pageSizeOptions.map((size) => (
                <option key={size} value={size}>
                  {size}
                </option>
              ))}
            </select>
          </label>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Button variant="toolbar" onClick={() => onPageChange(page - 1)} disabled={page <= 0}>
          ← Sebelumnya
        </Button>
        <Button
          variant="toolbar"
          onClick={() => onPageChange(page + 1)}
          disabled={page + 1 >= pageCount}
        >
          Berikutnya →
        </Button>
      </div>
    </div>
  );
}
