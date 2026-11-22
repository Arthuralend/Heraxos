import AVFoundation
import UIKit
import WebRTC

/// Экран идущего звонка (нативный): имя, время, видео собеседников, своя камера и кнопки.
/// Входящий звонок показывает система (CallKit); этот экран — после ответа и при исходящем.
/// Свернуть (стрелка вниз) — звонок продолжится, сверху появится зелёная плашка.
final class CallViewController: UIViewController {

    private let grid = UIStackView()
    private let info = UIStackView()
    private let ava = UILabel()
    private let nameLabel = UILabel()
    private let statusLabel = UILabel()
    private let local = RTCMTLVideoView()
    private let bar = UIStackView()
    private let bSpeaker = UIButton(type: .system)
    private let bCam = UIButton(type: .system)
    private let bFlip = UIButton(type: .system)
    private let bMute = UIButton(type: .system)
    private let bHang = UIButton(type: .system)
    private let bMin = UIButton(type: .system)
    private let bAdd = UIButton(type: .system)
    private let bGames = UIButton(type: .system)
    private let gradient = CAGradientLayer()

    private var renderers: [String: (RTCMTLVideoView, RTCVideoTrack)] = [:]
    private var localTrack: RTCVideoTrack?
    private var gridKey = "-"
    private var hidden = false
    private var timer: Timer?
    private var closing = false

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }
    override var supportedInterfaceOrientations: UIInterfaceOrientationMask { .portrait }

    override func viewDidLoad() {
        super.viewDidLoad()
        gradient.colors = [UIColor(red: 0.29, green: 0.18, blue: 0.13, alpha: 1).cgColor,
                           UIColor(red: 0.17, green: 0.16, blue: 0.15, alpha: 1).cgColor,
                           UIColor(red: 0.10, green: 0.10, blue: 0.09, alpha: 1).cgColor]
        view.layer.addSublayer(gradient)
        view.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(tapped)))

        grid.axis = .vertical; grid.distribution = .fillEqually; grid.spacing = 2
        add(grid)
        NSLayoutConstraint.activate([
            grid.topAnchor.constraint(equalTo: view.topAnchor), grid.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            grid.leadingAnchor.constraint(equalTo: view.leadingAnchor), grid.trailingAnchor.constraint(equalTo: view.trailingAnchor),
        ])

        // имя и состояние
        info.axis = .vertical; info.alignment = .center; info.spacing = 8
        ava.textAlignment = .center; ava.font = .systemFont(ofSize: 52, weight: .bold); ava.textColor = .white
        ava.layer.cornerRadius = 65; ava.clipsToBounds = true
        ava.widthAnchor.constraint(equalToConstant: 130).isActive = true
        ava.heightAnchor.constraint(equalToConstant: 130).isActive = true
        nameLabel.font = .systemFont(ofSize: 30, weight: .bold); nameLabel.textColor = .white
        nameLabel.textAlignment = .center; nameLabel.numberOfLines = 2
        statusLabel.font = .systemFont(ofSize: 17); statusLabel.textColor = UIColor(white: 1, alpha: 0.85)
        let lock = UILabel(); lock.text = "🔒 Зашифровано"; lock.font = .systemFont(ofSize: 13); lock.textColor = UIColor(white: 1, alpha: 0.5)
        for l in [nameLabel, statusLabel] { l.layer.shadowColor = UIColor.black.cgColor; l.layer.shadowOpacity = 0.6; l.layer.shadowRadius = 4; l.layer.shadowOffset = .zero }
        info.addArrangedSubview(ava); info.setCustomSpacing(20, after: ava)
        info.addArrangedSubview(nameLabel); info.addArrangedSubview(statusLabel); info.addArrangedSubview(lock)
        add(info)
        NSLayoutConstraint.activate([
            info.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 60),
            info.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 16),
            info.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -16),
        ])

        // своя камера
        local.videoContentMode = .scaleAspectFill
        local.layer.cornerRadius = 14; local.clipsToBounds = true
        local.isHidden = true
        local.addGestureRecognizer(UITapGestureRecognizer(target: self, action: #selector(flip)))
        add(local)
        NSLayoutConstraint.activate([
            local.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            local.trailingAnchor.constraint(equalTo: view.trailingAnchor, constant: -14),
            local.widthAnchor.constraint(equalToConstant: 104), local.heightAnchor.constraint(equalToConstant: 150),
        ])

        // свернуть / добавить участника
        style(bMin, "chevron.down", size: 44, color: UIColor(white: 1, alpha: 0.2)); bMin.addTarget(self, action: #selector(minimize), for: .touchUpInside)
        style(bAdd, "person.badge.plus", size: 44, color: UIColor(white: 1, alpha: 0.2)); bAdd.addTarget(self, action: #selector(addPerson), for: .touchUpInside)
        style(bGames, "gamecontroller.fill", size: 44, color: UIColor(white: 1, alpha: 0.2)); bGames.addTarget(self, action: #selector(games), for: .touchUpInside)
        bMin.accessibilityLabel = "Свернуть"; bAdd.accessibilityLabel = "Добавить участника"; bGames.accessibilityLabel = "Игры"
        add(bMin); add(bAdd); add(bGames)
        NSLayoutConstraint.activate([
            bGames.topAnchor.constraint(equalTo: bMin.bottomAnchor, constant: 64),
            bGames.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
        ])
        NSLayoutConstraint.activate([
            bMin.topAnchor.constraint(equalTo: view.safeAreaLayoutGuide.topAnchor, constant: 8),
            bMin.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
            bAdd.topAnchor.constraint(equalTo: bMin.bottomAnchor, constant: 10),
            bAdd.leadingAnchor.constraint(equalTo: view.leadingAnchor, constant: 14),
        ])

        // кнопки
        bar.axis = .horizontal; bar.spacing = 12; bar.alignment = .center
        bar.backgroundColor = UIColor(red: 0.10, green: 0.10, blue: 0.09, alpha: 0.55)
        bar.layer.cornerRadius = 40
        bar.isLayoutMarginsRelativeArrangement = true
        bar.layoutMargins = UIEdgeInsets(top: 11, left: 14, bottom: 11, right: 14)
        let gray = UIColor(white: 1, alpha: 0.2)
        style(bSpeaker, "speaker.wave.2.fill", size: 58, color: gray); bSpeaker.addTarget(self, action: #selector(speaker), for: .touchUpInside)
        style(bCam, "video.fill", size: 58, color: gray); bCam.addTarget(self, action: #selector(camera), for: .touchUpInside)
        style(bFlip, "arrow.triangle.2.circlepath.camera.fill", size: 58, color: gray); bFlip.addTarget(self, action: #selector(flip), for: .touchUpInside)
        style(bMute, "mic.slash.fill", size: 58, color: gray); bMute.addTarget(self, action: #selector(mute), for: .touchUpInside)
        style(bHang, "phone.down.fill", size: 58, color: UIColor(red: 0.78, green: 0.27, blue: 0.24, alpha: 1)); bHang.addTarget(self, action: #selector(hang), for: .touchUpInside)
        bSpeaker.accessibilityLabel = "Громкая связь"; bCam.accessibilityLabel = "Камера"; bFlip.accessibilityLabel = "Сменить камеру"
        bMute.accessibilityLabel = "Выключить микрофон"; bHang.accessibilityLabel = "Завершить"
        for b in [bSpeaker, bCam, bFlip, bMute, bHang] { bar.addArrangedSubview(b) }
        add(bar)
        NSLayoutConstraint.activate([
            bar.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            bar.bottomAnchor.constraint(equalTo: view.safeAreaLayoutGuide.bottomAnchor, constant: -22),
        ])
        refresh()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        gradient.frame = view.bounds
    }

    override func viewWillAppear(_ animated: Bool) {
        super.viewWillAppear(animated)
        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in self?.updateStatus() }
    }

    override func viewDidDisappear(_ animated: Bool) {
        super.viewDidDisappear(animated)
        timer?.invalidate(); timer = nil
        for (_, r) in renderers { r.1.remove(r.0) }
        renderers.removeAll(); gridKey = "-"
        localTrack?.remove(local); localTrack = nil
        CallManager.shared.callUIClosed()
    }

    private func add(_ v: UIView) { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }

    private func style(_ b: UIButton, _ symbol: String, size: CGFloat, color: UIColor) {
        let cfg = UIImage.SymbolConfiguration(pointSize: size * 0.36, weight: .semibold)
        b.setImage(UIImage(systemName: symbol, withConfiguration: cfg), for: .normal)
        b.tintColor = .white
        b.backgroundColor = color
        b.layer.cornerRadius = size / 2
        b.translatesAutoresizingMaskIntoConstraints = false
        b.widthAnchor.constraint(equalToConstant: size).isActive = true
        b.heightAnchor.constraint(equalToConstant: size).isActive = true
    }

    /// Включено (громкая, камера, микрофон выключен) — белая кнопка с тёмным значком
    private func setOn(_ b: UIButton, _ on: Bool) {
        b.backgroundColor = on ? .white : UIColor(white: 1, alpha: 0.2)
        b.tintColor = on ? UIColor(red: 0.10, green: 0.10, blue: 0.09, alpha: 1) : .white
    }

    // MARK: - Кнопки
    @objc private func speaker() {
        let e = CallEngine.shared
        e.toggleSpeaker()
        CallManager.shared.toast(e.speaker ? "🔊 Громкая связь" : "📱 Обычный режим (у уха)")
    }
    @objc private func camera() {
        if CallEngine.shared.camOn { CallEngine.shared.toggleCamera(); return }
        AVCaptureDevice.requestAccess(for: .video) { ok in
            DispatchQueue.main.async {
                if ok { CallEngine.shared.toggleCamera() } else { CallManager.shared.toast("Нет доступа к камере: Настройки → Ahazang → Камера") }
            }
        }
    }
    @objc private func flip() { CallEngine.shared.flipCamera() }
    @objc private func mute() { CallManager.shared.requestMute(!CallEngine.shared.muted) }
    @objc private func hang() { CallManager.shared.requestEnd() }
    @objc private func minimize() { dismiss(animated: true) }
    @objc private func games() { CallManager.shared.openGames(peer: CallEngine.shared.peerLogin) }

    @objc private func addPerson() {
        let e = CallEngine.shared
        e.contacts { [weak self] list in
            guard let self else { return }
            let inCall = Set((e.peers.map { $0.login } + e.pending).map { $0.lowercased() })
            let free = list.filter { !inCall.contains($0.0.lowercased()) }
            if free.isEmpty { CallManager.shared.toast("Все ваши контакты уже в звонке"); return }
            let ac = UIAlertController(title: "Позвать в звонок", message: nil, preferredStyle: .actionSheet)
            for c in free.prefix(30) { ac.addAction(UIAlertAction(title: c.1, style: .default) { _ in e.invite(login: c.0, name: c.1) }) }
            ac.addAction(UIAlertAction(title: "Отмена", style: .cancel))
            ac.popoverPresentationController?.sourceView = self.bAdd
            self.present(ac, animated: true)
        }
    }

    @objc private func tapped() {
        guard anyVideo() else { return }
        hidden.toggle()
        UIView.animate(withDuration: 0.2) { self.applyHidden() }
    }

    private func applyHidden() {
        let a: CGFloat = hidden ? 0 : 1
        bar.alpha = a; bMin.alpha = a; bAdd.alpha = a; bGames.alpha = a
        info.alpha = hidden || CallEngine.shared.peers.count + CallEngine.shared.pending.count > 1 ? 0 : 1
    }

    private func anyVideo() -> Bool {
        let e = CallEngine.shared
        return e.camOn || e.peers.contains { $0.video && $0.remoteVideo != nil }
    }

    // MARK: - Состояние
    func refresh() {
        guard isViewLoaded else { return }
        let e = CallEngine.shared
        if e.state == .idle || e.state == .ended {
            updateStatus()
            if !closing {
                closing = true
                DispatchQueue.main.asyncAfter(deadline: .now() + (e.state == .ended ? 1.3 : 0)) { [weak self] in self?.dismiss(animated: true) }
            }
            return
        }
        setOn(bSpeaker, e.speaker)
        setOn(bCam, e.camOn)
        setOn(bMute, e.muted)
        bFlip.isHidden = !e.camOn
        bAdd.isHidden = e.id == nil
        bGames.isHidden = e.peers.count > 1

        let who = e.peers.map { $0.login } + e.pending.filter { p in !e.peers.contains { $0.login.lowercased() == p.lowercased() } }
        let first = who.first ?? e.firstLogin
        let title = who.count <= 1 ? (first.isEmpty ? e.title : e.nameOf(first)) : who.map { e.nameOf($0) }.joined(separator: ", ")
        nameLabel.text = title
        ava.text = String(title.prefix(1)).uppercased()
        ava.backgroundColor = avatarColor(first.isEmpty ? title : first)
        let remoteVideo = e.peers.contains { $0.video && $0.remoteVideo != nil }
        ava.isHidden = remoteVideo || who.count > 1
        rebuildGrid(who)

        if e.localVideo !== localTrack {
            localTrack?.remove(local)
            localTrack = e.localVideo
            localTrack?.add(local)
        }
        local.isHidden = localTrack == nil
        local.transform = e.front ? CGAffineTransform(scaleX: -1, y: 1) : .identity
        if !anyVideo() { hidden = false }
        applyHidden()
        updateStatus()
    }

    private func updateStatus() {
        let e = CallEngine.shared
        if e.state == .active, e.peers.contains(where: { $0.lost != nil }) { statusLabel.text = "Переподключение…" }
        else if e.state == .active, let t0 = e.t0 {
            let s = Int(Date().timeIntervalSince(t0)); statusLabel.text = String(format: "%d:%02d", s / 60, s % 60)
        } else { statusLabel.text = e.status }
    }

    /// Сетка участников: видео — на всю плитку, без видео — инициал и имя
    private func rebuildGrid(_ who: [String]) {
        let e = CallEngine.shared
        let showGrid = who.count > 1 || e.peers.contains { $0.video && $0.remoteVideo != nil }
        let key = showGrid ? who.map { l -> String in
            let p = e.peer(l); return "\(l):\(p?.video == true && p?.remoteVideo != nil):\(p?.connected == true)"
        }.joined(separator: "|") : ""
        guard key != gridKey else { return }
        gridKey = key
        for (_, r) in renderers { r.1.remove(r.0) }
        renderers.removeAll()
        grid.arrangedSubviews.forEach { $0.removeFromSuperview() }
        guard showGrid else { return }
        let cols = who.count <= 2 ? 1 : 2
        var row: UIStackView?
        for (i, l) in who.enumerated() {
            if i % cols == 0 {
                let r = UIStackView(); r.axis = .horizontal; r.distribution = .fillEqually; r.spacing = 2
                grid.addArrangedSubview(r); row = r
            }
            let tile = UIView()
            tile.clipsToBounds = true
            let p = e.peer(l)
            if let p, p.video, let track = p.remoteVideo {
                let v = RTCMTLVideoView()
                v.videoContentMode = .scaleAspectFill
                v.translatesAutoresizingMaskIntoConstraints = false
                tile.addSubview(v)
                NSLayoutConstraint.activate([
                    v.topAnchor.constraint(equalTo: tile.topAnchor), v.bottomAnchor.constraint(equalTo: tile.bottomAnchor),
                    v.leadingAnchor.constraint(equalTo: tile.leadingAnchor), v.trailingAnchor.constraint(equalTo: tile.trailingAnchor),
                ])
                track.add(v)
                renderers[l.lowercased()] = (v, track)
            } else {
                tile.backgroundColor = UIColor(white: 1, alpha: 0.08)
                let a = UILabel()
                a.text = String(e.nameOf(l).prefix(1)).uppercased()
                a.font = .systemFont(ofSize: 30, weight: .bold); a.textColor = .white; a.textAlignment = .center
                a.backgroundColor = avatarColor(l); a.layer.cornerRadius = 38; a.clipsToBounds = true
                a.alpha = p?.connected == true ? 1 : 0.55
                a.translatesAutoresizingMaskIntoConstraints = false
                tile.addSubview(a)
                NSLayoutConstraint.activate([
                    a.centerXAnchor.constraint(equalTo: tile.centerXAnchor), a.centerYAnchor.constraint(equalTo: tile.centerYAnchor),
                    a.widthAnchor.constraint(equalToConstant: 76), a.heightAnchor.constraint(equalToConstant: 76),
                ])
            }
            if who.count > 1 {
                let n = UILabel()
                n.text = e.nameOf(l) + (p?.connected == true ? "" : " · вызов…")
                n.textColor = .white; n.font = .systemFont(ofSize: 13, weight: .medium)
                n.layer.shadowColor = UIColor.black.cgColor; n.layer.shadowOpacity = 0.8; n.layer.shadowRadius = 3; n.layer.shadowOffset = .zero
                n.translatesAutoresizingMaskIntoConstraints = false
                tile.addSubview(n)
                NSLayoutConstraint.activate([
                    n.leadingAnchor.constraint(equalTo: tile.leadingAnchor, constant: 10),
                    n.bottomAnchor.constraint(equalTo: tile.bottomAnchor, constant: -8),
                ])
            }
            row?.addArrangedSubview(tile)
        }
        // нечётное число в сетке 2×N — пустая плитка для ровной раскладки
        if cols == 2, who.count % 2 == 1 { row?.addArrangedSubview(UIView()) }
    }

    private func avatarColor(_ s: String) -> UIColor {
        let colors: [UInt32] = [0xC96442, 0xB5835A, 0x8B6F47, 0x6A8A82, 0x7E8FB8, 0xA26B8F, 0x5E8C61, 0xB8875A, 0x8C7AA9]
        var h: Int32 = 0
        for c in s.lowercased().unicodeScalars { h = h &* 31 &+ Int32(truncatingIfNeeded: c.value) }
        let v = colors[Int((Int(h) % colors.count + colors.count) % colors.count)]
        return UIColor(red: CGFloat((v >> 16) & 0xFF) / 255, green: CGFloat((v >> 8) & 0xFF) / 255, blue: CGFloat(v & 0xFF) / 255, alpha: 1)
    }
}
