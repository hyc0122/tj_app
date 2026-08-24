import type { TableProps } from "tdesign-vue-next";
import type { AssetsState } from "./useAssetsState";

export function useAssetsColumns(state: AssetsState) {
  const selectType = state.props.multiple === false ? "single" : "multiple";
  const columns: TableProps["columns"] = [
    {
      colKey: "row-select",
      type: selectType,
      width: 50,
      align: "center",
      fixed: "left",
      disabled: (row: any) => state.isGenerating(row.row?.id ?? row.id),
    },
    {
      colKey: "src",
      title: $t("workbench.assets.colPreview"),
      width: 100,
      align: "center",
      cell: "previewWithLoading",
    },
    { colKey: "name", title: $t("workbench.assets.colName"), width: 100, align: "left", ellipsis: true },
    {
      colKey: "prompt",
      title: $t("workbench.assets.colPrompt"),
      width: 200,
      align: "left",
      ellipsis: true,
      cell: "prompt",
    },
    {
      colKey: "describe",
      title: $t("workbench.assets.colDescribe"),
      width: 200,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "remark",
      title: $t("workbench.assets.colRemark"),
      minWidth: 200,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "startTime",
      title: $t("workbench.assets.colCreateTime"),
      width: 200,
      align: "center",
      cell: "startTime",
    },
    {
      colKey: "operation",
      title: $t("workbench.assets.colOperation"),
      width: 280,
      align: "center",
      fixed: "right",
      cell: "operation",
    },
  ];
  const subColumns: TableProps["columns"] = [
    { colKey: "row-select", type: selectType, width: 50, align: "center", fixed: "left" },
    {
      colKey: "src",
      title: $t("workbench.assets.colPreview"),
      width: 100,
      align: "center",
      cell: "previewWithLoading",
    },
    { colKey: "name", title: $t("workbench.assets.colName"), width: 100, align: "left", ellipsis: true },
    {
      colKey: "prompt",
      title: $t("workbench.assets.colPrompt"),
      width: 200,
      align: "left",
      ellipsis: true,
      cell: "prompt",
    },
    {
      colKey: "describe",
      title: $t("workbench.assets.colDescribe"),
      width: 100,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "remark",
      title: $t("workbench.assets.colRemark"),
      minWidth: 150,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "operation",
      title: $t("workbench.assets.colOperation"),
      width: 280,
      align: "center",
      fixed: "right",
      cell: "operation",
    },
  ];
  const clipColumns: TableProps["columns"] = [
    { colKey: "row-select", type: "multiple", width: 50, align: "center", fixed: "left" },
    { colKey: "name", title: $t("workbench.assets.colName"), width: 200, align: "left", ellipsis: true },
    {
      colKey: "describe",
      title: $t("workbench.assets.colDescribe"),
      width: 200,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "remark",
      title: $t("workbench.assets.colRemark"),
      minWidth: 200,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "startTime",
      title: $t("workbench.assets.colCreateTime"),
      width: 200,
      align: "center",
      cell: "startTime",
    },
    {
      colKey: "operation",
      title: $t("workbench.assets.colOperation"),
      width: 180,
      align: "center",
      fixed: "right",
      cell: "operation",
    },
  ];
  const audioColumns: TableProps["columns"] = [
    { colKey: "row-select", type: selectType, width: 50, align: "center", fixed: "left" },
    { colKey: "name", title: $t("workbench.assets.audioName"), width: 200, align: "left", ellipsis: true },
    { colKey: "sex", title: $t("workbench.assets.sex"), width: 200, align: "left", ellipsis: true },
    {
      colKey: "describe",
      title: $t("workbench.assets.colDescribe"),
      width: 200,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "startTime",
      title: $t("workbench.assets.colCreateTime"),
      width: 200,
      align: "center",
      cell: "startTime",
    },
    {
      colKey: "operation",
      title: $t("workbench.assets.colOperation"),
      width: 180,
      align: "center",
      fixed: "right",
      cell: "operation",
    },
  ];
  const subAudioColumns: TableProps["columns"] = [
    { colKey: "row-select", type: selectType, width: 50, align: "center", fixed: "left" },
    {
      colKey: "src",
      title: $t("workbench.assets.colPreview"),
      width: 100,
      align: "center",
      cell: "previewWithLoading",
    },
    {
      colKey: "prompt",
      title: $t("workbench.assets.audioText"),
      width: 100,
      align: "left",
      ellipsis: true,
    },
    {
      colKey: "operation",
      title: $t("workbench.assets.colOperation"),
      width: 280,
      align: "center",
      fixed: "right",
      cell: "operation",
    },
  ];
  return { columns, subColumns, clipColumns, audioColumns, subAudioColumns };
}
