# persist_4sd_self ∪ zscore_4sd_self: one joint call on the same 1,000 runs.
PERSIST_NEED, PERSIST_WIN = 5, 8
PERSIST_RED_NEED = 7
Z_YELLOW, Z_RED = 4.0, 6.0


def _expanding_mean_sd(X):
    X = np.asarray(X, dtype=np.float64)
    n = np.arange(1, X.shape[0] + 1, dtype=np.float64)[:, None]
    csum = np.cumsum(X, axis=0)
    mean = csum / n
    var = np.maximum(np.cumsum(X * X, axis=0) - mean * csum, 0.0) / np.maximum(n - 1.0, 1.0)
    sd = np.sqrt(var)
    sd[0] = np.nan
    return mean, sd


def _rolling_count(hits, win):
    hits = np.asarray(hits, dtype=np.int32)
    T = len(hits)
    out = np.zeros(T, dtype=np.int16)
    if T == 0:
        return out
    c = np.cumsum(np.r_[0, hits])
    w = min(win, T)
    out[w - 1 :] = c[w:] - c[: T - w + 1]
    if w > 1:
        out[: w - 1] = c[1:w]
    return out


def _raw_to_level(y_raw, r_raw, *, need_two):
    y = np.asarray(y_raw, dtype=bool).copy()
    r = np.asarray(r_raw, dtype=bool).copy()
    y[:BURNIN] = False
    r[:BURNIN] = False
    level = np.zeros(len(y), dtype=np.int8)
    if need_two:
        hit = np.zeros(len(y), dtype=bool)
        hit[BURNIN:] = y[BURNIN:] & y[BURNIN - 1 : -1]
        level[hit] = 1
    else:
        level[y] = 1
    level[r] = 2
    return level


def _self_zp_levels(X):
    mean, sd = _expanding_mean_sd(X)
    z = np.full_like(X, np.nan, dtype=np.float64)
    floor = np.maximum(1e-6 * np.abs(mean[:-1]), 1e-8)
    past_sd = np.maximum(sd[:-1], floor)
    with np.errstate(invalid="ignore", over="ignore", divide="ignore"):
        z[1:] = np.clip((X[1:] - mean[:-1]) / past_sd, -20.0, 20.0)
    zabs = np.abs(z)
    zmax = np.nanmax(np.where(np.isfinite(zabs), zabs, -np.inf), axis=1)
    zmax = np.where(np.isfinite(zmax), zmax, np.nan)
    z4 = np.isfinite(zmax) & (zmax >= Z_YELLOW)
    z6 = np.isfinite(zmax) & (zmax >= Z_RED)
    persist_n = _rolling_count(z4.astype(np.int8), PERSIST_WIN)
    z_lv = _raw_to_level(z4, z6, need_two=True)
    p_lv = _raw_to_level(persist_n >= PERSIST_NEED, persist_n >= PERSIST_RED_NEED, need_two=False)
    return z_lv, p_lv, np.maximum(z_lv, p_lv)


def _zpersist_summary():
    have = "cat_summary" in globals() and {"persist_4sd_self", "zscore_4sd_self"}.issubset(set(cat_summary["method"]))
    if have:
        log.info("zpersist    OR from cat_summary")
        p = cat_summary.loc[cat_summary["method"].eq("persist_4sd_self")]
        z = cat_summary.loc[cat_summary["method"].eq("zscore_4sd_self")]
        key = ["source", "IDV", "run"]
        both = p[key + ["csv_status", "alarm"]].rename(columns={"alarm": "alarm_p"})
        both = both.merge(z[key + ["alarm"]].rename(columns={"alarm": "alarm_z"}), on=key)
        both["alarm"] = ((both["alarm_p"].astype(int) + both["alarm_z"].astype(int)) > 0).astype(int)
        both["events_yellow"] = both["alarm"]
        both["events_red"] = 0
        both["method"] = "zpersist_self"
        return pd.concat([p, z, both], ignore_index=True)
    rows = []
    grouped = runs.sort_values(["source", "faultNumber", "simulationRun", "sample"]).groupby(
        ["source", "faultNumber", "simulationRun"], sort=False
    )
    t0 = time.time()
    n_groups = grouped.ngroups
    for i, ((src, fn, rn), g) in enumerate(grouped, start=1):
        z_lv, p_lv, both = _self_zp_levels(g[SENSOR_COLS].to_numpy(np.float64))
        status = str(g["fault_status"].iloc[0])
        for name, level in (("zscore_4sd_self", z_lv), ("persist_4sd_self", p_lv), ("zpersist_self", both)):
            ev_y = n_events(level, 1)
            ev_r = n_events(level, 2)
            rows.append(
                {
                    "method": name,
                    "source": str(src),
                    "IDV": int(fn),
                    "run": int(rn),
                    "csv_status": status,
                    "events_yellow": ev_y,
                    "events_red": ev_r,
                    "alarm": int((ev_y + ev_r) > 0),
                }
            )
        if i % 200 == 0 or i == n_groups:
            log.info("zpersist score %s / %s  %.1fs", i, n_groups, time.time() - t0)
    return pd.DataFrame(rows)


zp_summary = _zpersist_summary()
_fmt = {
    "TPR": "{:.3f}",
    "FPR": "{:.3f}",
    "Youden": "{:.3f}",
    "runs": "{:.0f}",
    "n_faulty": "{:.0f}",
    "n_normal": "{:.0f}",
    "TP": "{:.0f}",
    "FN": "{:.0f}",
    "FP": "{:.0f}",
    "TN": "{:.0f}",
}
head_rows = []
for mname, frame in (
    ("v5_combined", summary.assign(method="v5_combined")),
    ("zpersist_self", zp_summary.loc[zp_summary["method"].eq("zpersist_self")]),
    ("persist_4sd_self", zp_summary.loc[zp_summary["method"].eq("persist_4sd_self")]),
    ("zscore_4sd_self", zp_summary.loc[zp_summary["method"].eq("zscore_4sd_self")]),
):
    for split, sub in (
        ("all", frame),
        ("train", frame.loc[frame["source"].eq("train")]),
        ("test", frame.loc[frame["source"].eq("test")]),
    ):
        if len(sub) == 0:
            continue
        rec = detection_table(sub)
        rec["method"] = mname
        rec["split"] = split
        head_rows.append(rec)
zp_rates = pd.DataFrame(head_rows).set_index(["method", "split"])
print("Joint rule: persist_4sd_self OR zscore_4sd_self.  v5_combined = moments ∪ freeze ∪ amplitude.")
display(zp_rates.style.format(_fmt))
v5_all = zp_rates.loc[("v5_combined", "all")]
zp_all = zp_rates.loc[("zpersist_self", "all")]
d_youden = float(zp_all["Youden"] - v5_all["Youden"])
winner = "zpersist_self" if d_youden > 0 else ("v5_combined" if d_youden < 0 else "tie")
print(
    f"all  v5_combined    TPR={v5_all['TPR']:.3f}  FPR={v5_all['FPR']:.3f}  Youden={v5_all['Youden']:.3f}  "
    f"TP={int(v5_all['TP'])} FN={int(v5_all['FN'])} FP={int(v5_all['FP'])} TN={int(v5_all['TN'])}"
)
print(
    f"all  zpersist_self  TPR={zp_all['TPR']:.3f}  FPR={zp_all['FPR']:.3f}  Youden={zp_all['Youden']:.3f}  "
    f"TP={int(zp_all['TP'])} FN={int(zp_all['FN'])} FP={int(zp_all['FP'])} TN={int(zp_all['TN'])}  "
    f"vs_v5_Youden={d_youden:+.3f}  better={winner}"
)
fig, ax = plt.subplots(figsize=(8.5, 4.2))
labels = ["v5_combined", "zpersist_self", "persist_4sd_self", "zscore_4sd_self"]
x = np.arange(len(labels))
w = 0.36
ax.bar(x - w / 2, [zp_rates.loc[(m, "all"), "TPR"] for m in labels], w, color="#2C3E50", label="TPR")
ax.bar(x + w / 2, [zp_rates.loc[(m, "all"), "FPR"] for m in labels], w, color=RED, label="FPR")
ax.set_xticks(x, labels, rotation=20, ha="right")
ax.set_ylim(0, 1.05)
ax.set_ylabel("rate")
ax.set_title("v5 (moments ∪ freeze ∪ amp) vs persist ∪ zscore self")
ax.legend(frameon=False)
fig.tight_layout()
plt.show()
