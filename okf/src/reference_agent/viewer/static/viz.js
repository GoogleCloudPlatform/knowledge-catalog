(function () {
  const bundle = window.BUNDLE;
  const bundleName = window.BUNDLE_NAME;
  document.title = `${bundleName} — OKF Viewer`;
  document.getElementById("bundle-name").textContent = bundleName;

  // Populate type filter
  const typeSelect = document.getElementById("filter-type");
  for (const t of bundle.types) {
    const opt = document.createElement("option");
    opt.value = t;
    opt.textContent = t;
    typeSelect.appendChild(opt);
  }

  // Build reverse-link index for backlinks
  const backlinks = {};
  for (const edge of bundle.edges) {
    const { source, target } = edge.data;
    (backlinks[target] ||= []).push(source);
  }

  // Look up node label/type by id
  const nodeIndex = {};
  for (const n of bundle.nodes) nodeIndex[n.data.id] = n.data;

  const cy = cytoscape({
    container: document.getElementById("graph"),
    elements: [...bundle.nodes, ...bundle.edges],
    style: [
      {
        selector: "node",
        style: {
          "background-color": "data(color)",
          "label": "data(label)",
          "color": "#0f172a",
          "font-size": 11,
          "text-valign": "bottom",
          "text-margin-y": 4,
          "text-wrap": "wrap",
          "text-max-width": 120,
          "width": "data(size)",
          "height": "data(size)",
          "border-width": 1,
          "border-color": "#0f172a",
        },
      },
      {
        selector: "node:selected",
        style: {
          "border-width": 3,
          "border-color": "#f59e0b",
        },
      },
      {
        selector: "edge",
        style: {
          "width": 1.5,
          "line-color": "#cbd5e1",
          "target-arrow-color": "#cbd5e1",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "arrow-scale": 0.9,
        },
      },
      {
        selector: "edge:selected",
        style: {
          "line-color": "#f59e0b",
          "target-arrow-color": "#f59e0b",
          "width": 2.5,
        },
      },
      {
        selector: ".dim",
        style: { "opacity": 0.15 },
      },
      {
        selector: "node.focus",
        style: { "border-width": 3, "border-color": "#f59e0b" },
      },
      {
        selector: "edge.incident",
        style: { "width": 3 },
      },
      {
        selector: ".mid",
        style: { "opacity": 0.5 },
      },
      {
        selector: ".far",
        style: { "opacity": 0.12 },
      },
    ],
    layout: { name: "cose", animate: false, padding: 30 },
    wheelSensitivity: 0.2,
  });

  cy.on("tap", "node", (evt) => selectNode(evt.target.id()));
  cy.on("tap", (evt) => {
    if (evt.target === cy) clearSelection();
  });

  document.getElementById("layout").addEventListener("change", (e) => {
    cy.layout({ name: e.target.value, animate: false, padding: 30 }).run();
  });

  document.getElementById("reset").addEventListener("click", () => {
    cy.fit(null, 30);
    clearSelection();
  });

  document.getElementById("search").addEventListener("input", (e) => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) {
      cy.elements().removeClass("dim");
      return;
    }
    cy.nodes().forEach((n) => {
      const d = n.data();
      const hay =
        (d.label || "").toLowerCase() + " " +
        d.id.toLowerCase() + " " +
        (d.tags || []).join(" ").toLowerCase();
      n.toggleClass("dim", !hay.includes(q));
    });
    cy.edges().forEach((edge) => {
      const src = edge.source();
      const tgt = edge.target();
      edge.toggleClass("dim", src.hasClass("dim") || tgt.hasClass("dim"));
    });
  });

  document.getElementById("filter-type").addEventListener("change", (e) => {
    const t = e.target.value;
    if (!t) {
      cy.elements().removeClass("dim");
      return;
    }
    cy.nodes().forEach((n) => {
      n.toggleClass("dim", n.data("type") !== t);
    });
    cy.edges().forEach((edge) => {
      edge.toggleClass("dim", edge.source().hasClass("dim") || edge.target().hasClass("dim"));
    });
  });

  function clearSelection() {
    cy.elements().unselect();
    resetHighlight();
    document.getElementById("detail-empty").hidden = false;
    document.getElementById("detail-content").hidden = true;
  }

  function resetHighlight() {
    cy.elements().removeClass("dim focus incident near mid far");
  }

  // Click-to-focus: fade the graph by hop distance from the clicked node —
  // 0-1 hops bright, 2 hops medium, 3+ / unreachable faint — so it is obvious
  // what a concept connects to without losing the surrounding context.
  function focusNeighborhood(nodeId) {
    const node = cy.getElementById(nodeId);
    resetHighlight();
    if (!node || node.empty()) return;
    const dist = {};
    cy.elements().bfs({
      roots: node,
      directed: false,
      visit: (v, e, u, i, depth) => {
        dist[v.id()] = depth;
      },
    });
    const tier = (d) => (d == null ? "far" : d <= 1 ? "near" : d === 2 ? "mid" : "far");
    cy.batch(() => {
      cy.nodes().forEach((n) => n.addClass(tier(dist[n.id()])));
      cy.edges().forEach((ed) => {
        const ds = dist[ed.source().id()];
        const dt = dist[ed.target().id()];
        const dd = ds == null || dt == null ? null : Math.max(ds, dt);
        ed.addClass(tier(dd));
      });
      node.addClass("focus");
      node.connectedEdges().addClass("incident");
    });
  }

  function selectNode(nodeId) {
    showDetail(nodeId);
    focusNeighborhood(nodeId);
  }

  function showDetail(conceptId) {
    const data = nodeIndex[conceptId];
    if (!data) return;
    cy.elements().unselect();
    const node = cy.getElementById(conceptId);
    if (node) node.select();

    document.getElementById("detail-empty").hidden = true;
    const content = document.getElementById("detail-content");
    content.hidden = false;

    const chip = document.getElementById("detail-type");
    chip.textContent = data.type;
    chip.style.background = data.color;

    document.getElementById("detail-title").textContent = data.label;
    const idEl = document.getElementById("detail-id");
    idEl.innerHTML = "";
    const parts = conceptId.split("/");
    parts.forEach((seg, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "bc-sep";
        sep.textContent = "/";
        idEl.appendChild(sep);
      }
      const isLast = i === parts.length - 1;
      const prefixId = parts.slice(0, i + 1).join("/");
      if (!isLast && nodeIndex[prefixId]) {
        const a = document.createElement("a");
        a.className = "internal";
        a.textContent = seg;
        a.addEventListener("click", () => selectNode(prefixId));
        idEl.appendChild(a);
      } else {
        const span = document.createElement("span");
        span.className = isLast ? "bc-current" : "bc-seg";
        span.textContent = seg;
        idEl.appendChild(span);
      }
    });
    document.getElementById("detail-description").textContent = data.description || "—";

    const resourceEl = document.getElementById("detail-resource");
    resourceEl.innerHTML = "";
    if (data.resource) {
      const a = document.createElement("a");
      a.href = data.resource;
      a.textContent = data.resource;
      a.target = "_blank";
      a.rel = "noopener";
      a.className = "external";
      resourceEl.appendChild(a);
    } else {
      resourceEl.textContent = "—";
    }

    const tagsEl = document.getElementById("detail-tags");
    tagsEl.innerHTML = "";
    if (data.tags && data.tags.length) {
      for (const t of data.tags) {
        const span = document.createElement("span");
        span.className = "tag";
        span.textContent = t;
        tagsEl.appendChild(span);
      }
    } else {
      tagsEl.textContent = "—";
    }

    // Siblings — other concepts in the same directory group.
    const sibSection = document.getElementById("detail-siblings");
    const sibList = document.getElementById("siblings-list");
    sibList.innerHTML = "";
    const parentPrefix = parts.slice(0, -1).join("/");
    const siblings = bundle.nodes
      .map((n) => n.data.id)
      .filter((id) => id !== conceptId)
      .filter((id) => id.split("/").slice(0, -1).join("/") === parentPrefix);
    if (siblings.length) {
      sibSection.hidden = false;
      for (const sid of siblings) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.className = "internal";
        a.textContent = nodeIndex[sid]?.label || sid;
        a.addEventListener("click", () => selectNode(sid));
        li.appendChild(a);
        sibList.appendChild(li);
      }
    } else {
      sibSection.hidden = true;
    }

    const body = bundle.bodies[conceptId] || "";
    const html = marked.parse(body, { breaks: false, gfm: true });
    const bodyEl = document.getElementById("detail-body");
    bodyEl.innerHTML = html;
    rewriteInternalLinks(bodyEl);

    const bl = backlinks[conceptId] || [];
    const blSection = document.getElementById("detail-backlinks");
    const blList = document.getElementById("backlinks-list");
    blList.innerHTML = "";
    if (bl.length) {
      blSection.hidden = false;
      for (const src of bl) {
        const li = document.createElement("li");
        const a = document.createElement("a");
        a.textContent = nodeIndex[src]?.label || src;
        a.dataset.target = src;
        a.addEventListener("click", () => selectNode(src));
        li.appendChild(a);
        const muted = document.createElement("span");
        muted.className = "muted";
        muted.textContent = ` (${src})`;
        li.appendChild(muted);
        blList.appendChild(li);
      }
    } else {
      blSection.hidden = true;
    }

    cy.animate({ center: { eles: node }, zoom: Math.max(cy.zoom(), 1.0) }, { duration: 200 });
  }

  function rewriteInternalLinks(root) {
    root.querySelectorAll("a[href]").forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;
      if (href.startsWith("/") && href.endsWith(".md")) {
        const target = href.slice(1, -3);
        if (nodeIndex[target]) {
          a.className = "internal";
          a.setAttribute("href", "javascript:void(0)");
          a.addEventListener("click", (e) => {
            e.preventDefault();
            selectNode(target);
          });
          return;
        }
      }
      a.className = "external";
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener");
    });
  }

  // Auto-show the first node (a dataset if available, else first concept)
  const initial =
    bundle.nodes.find((n) => n.data.type === "BigQuery Dataset") ||
    bundle.nodes[0];
  if (initial) showDetail(initial.data.id);
})();
