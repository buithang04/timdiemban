(function () {
  const nav = document.getElementById("mainNav");
  const toggle = document.getElementById("menuToggle");

  toggle?.addEventListener("click", () => {
    nav?.classList.toggle("open");
  });

  nav?.querySelectorAll("a").forEach((a) => {
    a.addEventListener("click", () => nav.classList.remove("open"));
  });

  const io = new IntersectionObserver(
    (entries) => {
      entries.forEach((e) => {
        if (e.isIntersecting) e.target.classList.add("in");
      });
    },
    { threshold: 0.12, rootMargin: "0px 0px -40px 0px" }
  );

  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  const termsWrap = document.getElementById("termsWrap");
  const termsToggle = document.getElementById("termsToggle");
  termsToggle?.addEventListener("click", () => {
    const expanded = termsWrap?.classList.toggle("is-expanded");
    termsToggle.setAttribute("aria-expanded", expanded ? "true" : "false");
    termsToggle.textContent = expanded ? "Thu gọn" : "Xem thêm";
    if (!expanded) {
      document.getElementById("chinh-sach")?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
  });
})();
