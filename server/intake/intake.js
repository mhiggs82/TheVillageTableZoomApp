(function () {
  var BANDS = [["1", "12 to 13"], ["2", "14 to 15"], ["3", "16 to 17"], ["4", "18 or older"]];
  var form = document.getElementById("intake"), result = document.getElementById("result");
  var countEl = document.getElementById("count"), kidsEl = document.getElementById("kids");
  var errorEl = document.getElementById("error"), codeEl = document.getElementById("code");
  var copiedEl = document.getElementById("copied"), submitBtn = form.querySelector('button[type="submit"]');

  function renderKids() {
    var n = parseInt(countEl.value, 10) || 0, html = "";
    for (var i = 1; i <= n; i++) {
      html += '<div class="kid"><label for="age' + i + '">Child ' + i + (n === 4 && i === 4 ? " (or your fourth oldest)" : "") + '</label><select id="age' + i + '" required><option value="">Choose an age range</option>';
      for (var j = 0; j < BANDS.length; j++) html += '<option value="' + BANDS[j][0] + '">' + BANDS[j][1] + "</option>";
      html += "</select></div>";
    }
    if (n) html += '<p class="hint">If a child is younger than 12, choose 12 to 13.</p>';
    kidsEl.innerHTML = html;
  }
  countEl.addEventListener("change", renderKids);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var loc = document.getElementById("where").value, n = parseInt(countEl.value, 10) || 0;
    var life = document.getElementById("life").value, fam = document.getElementById("family").value;
    var bands = [], missing = !loc || !n || !life || !fam;
    for (var i = 1; i <= n; i++) {
      var v = document.getElementById("age" + i).value;
      if (!v) missing = true; else bands.push(parseInt(v, 10));
    }
    if (missing) { errorEl.textContent = "Please answer every question so your code is accurate."; return; }
    errorEl.textContent = "";
    submitBtn.disabled = true;
    // The secret key never leaves the server: the answers go over HTTPS, come back as a code, and are not kept.
    fetch("/api/encode", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ location: parseInt(loc, 10), bands: bands, life: parseInt(life, 10), family: parseInt(fam, 10) })
    }).then(function (res) {
      return res.json().then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok || !r.data.code) throw new Error(r.data && r.data.error);
      codeEl.textContent = r.data.code;
      form.hidden = true; result.hidden = false; copiedEl.textContent = "";
      window.scrollTo(0, 0);
    }).catch(function (err) {
      errorEl.textContent = (err && err.message) || "Something went wrong. Please try again in a moment.";
    }).then(function () { submitBtn.disabled = false; });
  });

  document.getElementById("copy").addEventListener("click", function () {
    var text = codeEl.textContent;
    try {
      navigator.clipboard.writeText(text).then(function () { copiedEl.textContent = "Copied."; },
        function () { copiedEl.textContent = "Copy was blocked. Select the code above and copy it."; });
    } catch (err) { copiedEl.textContent = "Copy was blocked. Select the code above and copy it."; }
  });

  document.getElementById("again").addEventListener("click", function () {
    form.reset(); renderKids(); codeEl.textContent = ""; result.hidden = true; form.hidden = false; errorEl.textContent = "";
    window.scrollTo(0, 0);
  });
})();
