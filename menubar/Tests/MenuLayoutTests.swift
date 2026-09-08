import AppKit
import SwiftUI
import Testing

@testable import BuncargoBar

@Test @MainActor
func menuReportsItsHeightBeforeOpeningAndAfterContentChanges() {
    _ = NSApplication.shared

    func menu(height: CGFloat) -> some View {
        MenuContentLayout {
            Color.clear.frame(height: height)
        }
    }

    let view = NSHostingView(rootView: menu(height: 240))

    // The first size query must be correct without a render pass or preference callback.
    // MenuBarExtra uses it to create the window; a temporary 320pt height left empty bands.
    #expect(view.fittingSize == NSSize(width: 320, height: 240))

    // Discovery can grow and shrink the content while the menu remains open.
    view.rootView = menu(height: 900)
    #expect(view.fittingSize == NSSize(width: 320, height: 620))

    view.rootView = menu(height: 120)
    #expect(view.fittingSize == NSSize(width: 320, height: 120))
}

@Test @MainActor
func windowFollowsContentHeightKeepingItsTopEdge() {
    _ = NSApplication.shared
    let window = NSWindow(
        contentRect: NSRect(x: 100, y: 100, width: 320, height: 300),
        styleMask: .borderless, backing: .buffered, defer: false
    )
    let fitter = WindowHeightFitter.FitterView()
    window.contentView?.addSubview(fitter)
    let top = window.frame.maxY

    fitter.height = 180
    fitter.fit()
    #expect(window.frame.size == NSSize(width: 320, height: 180))
    #expect(window.frame.maxY == top)

    fitter.height = 400
    fitter.fit()
    #expect(window.frame.size == NSSize(width: 320, height: 400))
    #expect(window.frame.maxY == top)
}
